import pg from 'pg'
import type { Blocker, EnvironmentConfig, HistoryRow, Migration, MigrationSimulation, Note, StatementResult } from '../types.js'
import { analyze, parseScript } from '../sql/analyze.js'
import { ConcurrentRunError, type ApplyResult, type Driver, type DriverCapabilities, type SimulateOptions } from './driver.js'
import { diffSnapshots, takeSnapshot } from './postgres-snapshot.js'

const HISTORY = 'migration_console.history'

/** Same key on every runner, so two consoles cannot apply migrations to one database at the same time. */
const ADVISORY_LOCK = 7_243_001

const oneLine = (e: unknown) => {
  const err = e as { message?: string; code?: string; position?: string; detail?: string; hint?: string }
  return [err.code ? `[${err.code}]` : '', err.message ?? String(e), err.detail, err.hint ? `Hint: ${err.hint}` : ''].filter(Boolean).join(' ')
}

export class PostgresDriver implements Driver {
  readonly name = 'postgres' as const
  readonly capabilities: DriverCapabilities = { transactionalDDL: true, catalogDiff: true }
  private client: pg.Client | null = null

  constructor(private readonly env: EnvironmentConfig) {}

  private get db(): pg.Client {
    if (!this.client) throw new Error('Not connected')
    return this.client
  }

  async connect() {
    this.client = new pg.Client({ connectionString: this.env.url, application_name: 'migration-console', connectionTimeoutMillis: 10_000 })
    await this.client.connect()
  }

  async close() {
    const c = this.client
    this.client = null
    if (c) await c.end().catch(() => undefined)
  }

  async readHistory(): Promise<HistoryRow[] | null> {
    const exists = await this.db.query(`select to_regclass($1) as t`, [HISTORY])
    if (!exists.rows[0]?.t) return null
    const { rows } = await this.db.query(`select version, name, checksum, status, baselined, started_at, finished_at, duration_ms, applied_by, error from ${HISTORY} order by version`)
    return rows.map(r => ({
      version: r.version, name: r.name, checksum: r.checksum, status: r.status, baselined: r.baselined,
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : null, finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      durationMs: r.duration_ms, appliedBy: r.applied_by, error: r.error,
    }))
  }

  async initHistory() {
    await this.db.query(`
      create schema if not exists migration_console;
      create table if not exists ${HISTORY} (
        version     text primary key,
        name        text not null,
        checksum    text not null,
        status      text not null check (status in ('running', 'completed', 'failed')),
        baselined   boolean not null default false,
        started_at  timestamptz,
        finished_at timestamptz,
        duration_ms integer,
        applied_by  text,
        error       text
      );
      comment on table ${HISTORY} is 'Written by migration-console: what was applied here, when and by whom.';`)
  }

  async baseline(migrations: Migration[], user: string) {
    await this.initHistory()
    for (const m of migrations) {
      await this.db.query(
        `insert into ${HISTORY} (version, name, checksum, status, baselined, started_at, finished_at, applied_by)
         values ($1, $2, $3, 'completed', true, now(), now(), $4)
         on conflict (version) do nothing`,
        [m.version, m.name, m.checksum, user],
      )
    }
  }

  async blockers(tables: string[]): Promise<Blocker[]> {
    const { rows } = await this.db.query(
      `select a.pid, a.state, a.application_name, extract(epoch from now() - a.xact_start)::int as open_for, left(a.query, 160) as query
         from pg_stat_activity a
        where a.datname = current_database() and a.pid <> pg_backend_pid() and a.xact_start is not null
          and now() - a.xact_start > interval '30 seconds'
          and (a.state = 'idle in transaction' or exists (
                select 1 from pg_locks l where l.pid = a.pid and l.relation is not null and l.relation::regclass::text = any($1)))
        order by a.xact_start limit 20`,
      [tables],
    ).catch(() => ({ rows: [] as any[] }))
    return rows.map(r => ({ pid: r.pid, state: r.state, application: r.application_name || null, openForSeconds: r.open_for, query: r.query }))
  }

  private async limits(o: SimulateOptions) {
    await this.db.query(`set local lock_timeout = ${Math.max(0, Math.floor(o.lockTimeoutMs))}`)
    await this.db.query(`set local statement_timeout = ${Math.max(0, Math.floor(o.statementTimeoutMs))}`)
    // Backstop: whatever happens, an abandoned transaction cannot stay open.
    await this.db.query(`set local idle_in_transaction_session_timeout = ${Math.max(60_000, Math.floor(o.statementTimeoutMs) * 2)}`)
  }

  /**
   * Run the chain inside one transaction and roll it back at the end — in a `finally`, so a thrown error cannot skip it.
   * Transaction-control statements of the script (BEGIN / COMMIT…) are never sent: a COMMIT inside a script would
   * otherwise make the "simulation" permanent. Statements that cannot run in a transaction are skipped and reported.
   */
  async simulate(migrations: Migration[], options: SimulateOptions): Promise<MigrationSimulation[]> {
    const schemas = this.env.schemas?.length ? this.env.schemas : ['public']
    const results: MigrationSimulation[] = []
    await this.db.query('begin')
    try {
      await this.limits(options)
      let before = await takeSnapshot(this.db, schemas)
      let failed: string | null = null
      for (const m of migrations) {
        const statements = parseScript(m.sql, 'postgres')
        const findings = analyze(statements, 'postgres')
        const base = { version: m.version, name: m.name, findings }
        if (failed) {
          results.push({ ...base, outcome: 'skipped', skippedReason: `Depends on ${failed}, which failed.`, skippedInfo: { code: 'depends-on-failed', params: { version: failed } }, durationMs: 0, statements: [], changes: [], noop: false })
          continue
        }
        const started = Date.now()
        const ran: StatementResult[] = []
        await this.db.query('savepoint mc_migration')
        let error: string | undefined
        let errorInfo: Note | undefined
        for (const s of statements) {
          const entry: StatementResult = { index: s.index, line: s.line, summary: s.summary, kind: s.kind }
          if (s.kind === 'transaction-control') { ran.push({ ...entry, skipped: 'Transaction control: the console handles it.', skippedCode: 'transaction-control' }); continue }
          if (s.nonTransactional) { ran.push({ ...entry, skipped: 'Cannot run inside a transaction; it was not simulated.', skippedCode: 'not-transactional' }); continue }
          try {
            const r = await this.db.query(s.text)
            const last = Array.isArray(r) ? r[r.length - 1] : r
            ran.push(s.kind === 'dml' ? { ...entry, rowCount: last?.rowCount ?? null } : entry)
          } catch (e) {
            const detail = oneLine(e)
            error = `Statement ${s.index} (line ${s.line}): ${detail}`
            errorInfo = { code: 'statement-failed', params: { statement: s.index, line: s.line, detail } }
            ran.push({ ...entry, skipped: 'Failed.', skippedCode: 'failed' })
            break
          }
        }
        if (error) {
          await this.db.query('rollback to savepoint mc_migration')
          failed = m.version
          results.push({ ...base, outcome: 'failed', error, errorInfo, durationMs: Date.now() - started, statements: ran, changes: [], noop: false })
          continue
        }
        await this.db.query('release savepoint mc_migration')
        const after = await takeSnapshot(this.db, schemas)
        const changes = diffSnapshots(before, after)
        const wroteRows = ran.some(r => (r.rowCount ?? 0) > 0)
        results.push({ ...base, outcome: 'ok', durationMs: Date.now() - started, statements: ran, changes, noop: changes.length === 0 && !wroteRows })
        before = after
      }
    } finally {
      // Always. There is deliberately no `commit` anywhere in this method.
      await this.db.query('rollback').catch(() => undefined)
    }
    return results
  }

  async apply(m: Migration, user: string, options: SimulateOptions): Promise<ApplyResult> {
    const statements = parseScript(m.sql, 'postgres')
    const partial = statements.some(s => s.nonTransactional)
    const got = await this.db.query('select pg_try_advisory_lock($1) as ok', [ADVISORY_LOCK])
    if (!got.rows[0]?.ok) throw new ConcurrentRunError()
    const started = Date.now()
    try {
      await this.db.query(
        `insert into ${HISTORY} (version, name, checksum, status, started_at, applied_by)
         values ($1, $2, $3, 'running', now(), $4)
         on conflict (version) do update set name = excluded.name, checksum = excluded.checksum, status = 'running', baselined = false, started_at = now(), finished_at = null, duration_ms = null, applied_by = excluded.applied_by, error = null`,
        [m.version, m.name, m.checksum, user],
      )
      const finish = (ms: number) => this.db.query(`update ${HISTORY} set status = 'completed', finished_at = now(), duration_ms = $2 where version = $1`, [m.version, ms])
      try {
        if (!partial) {
          await this.db.query('begin')
          await this.limits(options)
          for (const s of statements) if (s.kind !== 'transaction-control') await this.db.query(s.text)
          await finish(Date.now() - started)               // inside the same transaction: both happen or neither
          await this.db.query('commit')
        } else {
          // Statements that need autocommit (CREATE INDEX CONCURRENTLY…): no wrapping transaction, so no all-or-nothing.
          await this.db.query(`set lock_timeout = ${Math.floor(options.lockTimeoutMs)}`)
          for (const s of statements) if (s.kind !== 'transaction-control') await this.db.query(s.text)
          await finish(Date.now() - started)
        }
      } catch (e) {
        await this.db.query('rollback').catch(() => undefined)
        await this.db.query(`update ${HISTORY} set status = 'failed', finished_at = now(), duration_ms = $2, error = $3 where version = $1`, [m.version, Date.now() - started, oneLine(e)])
        throw e
      }
      return { durationMs: Date.now() - started, partial }
    } finally {
      await this.db.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK]).catch(() => undefined)
    }
  }
}
