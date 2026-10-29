import { createConnection, type Connection } from 'mysql2/promise'
import type { Blocker, EnvironmentConfig, HistoryRow, Migration, MigrationSimulation } from '../types.js'
import { parseScript } from '../sql/analyze.js'
import { ConcurrentRunError, type ApplyResult, type Driver, type DriverCapabilities, type SimulateOptions } from './driver.js'
import { staticSimulation } from './static.js'

const HISTORY = 'migration_console_history'
const LOCK_NAME = 'migration-console'

/**
 * MySQL. DDL confirms the transaction in progress, so a migration cannot be executed and rolled back: the simulation is
 * static (what the script contains and what is risky) and applying runs the statements one by one, with no
 * all-or-nothing. NOT yet tested against a real server.
 */
export class MysqlDriver implements Driver {
  readonly name = 'mysql' as const
  readonly capabilities: DriverCapabilities = { transactionalDDL: false, catalogDiff: false }
  private conn: Connection | null = null

  constructor(private readonly env: EnvironmentConfig) {}

  private get db(): Connection {
    if (!this.conn) throw new Error('Not connected')
    return this.conn
  }

  async connect() { this.conn = await createConnection({ uri: this.env.url, connectTimeout: 10_000, multipleStatements: false }) }
  async close() { const c = this.conn; this.conn = null; if (c) await c.end().catch(() => undefined) }

  async readHistory(): Promise<HistoryRow[] | null> {
    const [exists] = await this.db.query<any[]>(`select 1 as x from information_schema.tables where table_schema = database() and table_name = ?`, [HISTORY])
    if (!exists.length) return null
    const [rows] = await this.db.query<any[]>(`select version, name, checksum, status, baselined, started_at, finished_at, duration_ms, applied_by, error from ${HISTORY} order by version`)
    return rows.map(r => ({
      version: r.version, name: r.name, checksum: r.checksum, status: r.status, baselined: !!r.baselined,
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : null, finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      durationMs: r.duration_ms, appliedBy: r.applied_by, error: r.error,
    }))
  }

  async initHistory() {
    await this.db.query(`create table if not exists ${HISTORY} (
      version varchar(64) primary key, name varchar(255) not null, checksum char(64) not null,
      status enum('running','completed','failed') not null, baselined tinyint(1) not null default 0,
      started_at datetime null, finished_at datetime null, duration_ms int null, applied_by varchar(255) null, error text null)`)
  }

  async baseline(migrations: Migration[], user: string) {
    await this.initHistory()
    for (const m of migrations) {
      await this.db.query(`insert ignore into ${HISTORY} (version, name, checksum, status, baselined, started_at, finished_at, applied_by) values (?, ?, ?, 'completed', 1, now(), now(), ?)`, [m.version, m.name, m.checksum, user])
    }
  }

  async blockers(_tables: string[]): Promise<Blocker[]> {
    const [rows] = await this.db.query<any[]>(`select trx_mysql_thread_id as pid, trx_state as state, timestampdiff(second, trx_started, now()) as open_for, left(trx_query, 160) as query
      from information_schema.innodb_trx where timestampdiff(second, trx_started, now()) > 30 order by trx_started limit 20`).catch(() => [[]] as any)
    return (rows as any[]).map(r => ({ pid: Number(r.pid), state: r.state ?? null, application: null, openForSeconds: r.open_for ?? null, query: r.query ?? '' }))
  }

  async simulate(migrations: Migration[], _options: SimulateOptions): Promise<MigrationSimulation[]> {
    return staticSimulation(migrations, 'mysql')
  }

  async apply(m: Migration, user: string, options: SimulateOptions): Promise<ApplyResult> {
    const statements = parseScript(m.sql, 'mysql')
    const [lock] = await this.db.query<any[]>(`select get_lock(?, 0) as ok`, [LOCK_NAME])
    if (!lock[0]?.ok) throw new ConcurrentRunError()
    const started = Date.now()
    try {
      await this.db.query(`insert into ${HISTORY} (version, name, checksum, status, started_at, applied_by) values (?, ?, ?, 'running', now(), ?)
        on duplicate key update name = values(name), checksum = values(checksum), status = 'running', baselined = 0, started_at = now(), finished_at = null, duration_ms = null, applied_by = values(applied_by), error = null`,
      [m.version, m.name, m.checksum, user])
      try {
        await this.db.query(`set session lock_wait_timeout = ?`, [Math.max(1, Math.floor(options.lockTimeoutMs / 1000))])
        for (const s of statements) if (s.kind !== 'transaction-control') await this.db.query(s.text)
        await this.db.query(`update ${HISTORY} set status = 'completed', finished_at = now(), duration_ms = ? where version = ?`, [Date.now() - started, m.version])
      } catch (e) {
        await this.db.query(`update ${HISTORY} set status = 'failed', finished_at = now(), duration_ms = ?, error = ? where version = ?`, [Date.now() - started, (e as Error).message, m.version])
        throw e
      }
      return { durationMs: Date.now() - started, partial: statements.some(s => s.kind === 'ddl') }
    } finally {
      await this.db.query(`select release_lock(?)`, [LOCK_NAME]).catch(() => undefined)
    }
  }
}
