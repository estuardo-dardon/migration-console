import sql from 'mssql'
import type { Blocker, EnvironmentConfig, HistoryRow, Migration, MigrationSimulation } from '../types.js'
import { parseScript } from '../sql/analyze.js'
import { ConcurrentRunError, type ApplyResult, type Driver, type DriverCapabilities, type SimulateOptions } from './driver.js'
import { staticSimulation } from './static.js'

const HISTORY = 'migration_console.history'
const LOCK_RESOURCE = 'migration-console'

/**
 * SQL Server. DDL is transactional here, so applying is all-or-nothing; the simulation is static for now (the catalog
 * diff is implemented for Postgres only). NOT yet tested against a real server.
 */
export class MssqlDriver implements Driver {
  readonly name = 'mssql' as const
  readonly capabilities: DriverCapabilities = { transactionalDDL: true, catalogDiff: false }
  private pool: sql.ConnectionPool | null = null

  constructor(private readonly env: EnvironmentConfig) {}

  private get db(): sql.ConnectionPool {
    if (!this.pool) throw new Error('Not connected')
    return this.pool
  }

  async connect() { this.pool = await new sql.ConnectionPool(this.env.url).connect() }
  async close() { const p = this.pool; this.pool = null; if (p) await p.close().catch(() => undefined) }

  async readHistory(): Promise<HistoryRow[] | null> {
    const exists = await this.db.request().query(`select object_id('${HISTORY}') as id`)
    if (!exists.recordset[0]?.id) return null
    const r = await this.db.request().query(`select version, name, checksum, status, baselined, started_at, finished_at, duration_ms, applied_by, error from ${HISTORY} order by version`)
    return r.recordset.map((x: any) => ({
      version: x.version, name: x.name, checksum: x.checksum, status: x.status, baselined: !!x.baselined,
      startedAt: x.started_at ? new Date(x.started_at).toISOString() : null, finishedAt: x.finished_at ? new Date(x.finished_at).toISOString() : null,
      durationMs: x.duration_ms, appliedBy: x.applied_by, error: x.error,
    }))
  }

  async initHistory() {
    await this.db.request().batch(`if schema_id('migration_console') is null exec('create schema migration_console')`)
    await this.db.request().batch(`if object_id('${HISTORY}') is null create table ${HISTORY} (
      version nvarchar(64) not null primary key, name nvarchar(255) not null, checksum char(64) not null,
      status nvarchar(16) not null check (status in ('running','completed','failed')), baselined bit not null default 0,
      started_at datetime2 null, finished_at datetime2 null, duration_ms int null, applied_by nvarchar(255) null, error nvarchar(max) null)`)
  }

  async baseline(migrations: Migration[], user: string) {
    await this.initHistory()
    for (const m of migrations) {
      await this.db.request().input('v', m.version).input('n', m.name).input('c', m.checksum).input('u', user)
        .query(`if not exists (select 1 from ${HISTORY} where version = @v) insert into ${HISTORY} (version, name, checksum, status, baselined, started_at, finished_at, applied_by) values (@v, @n, @c, 'completed', 1, sysutcdatetime(), sysutcdatetime(), @u)`)
    }
  }

  async blockers(_tables: string[]): Promise<Blocker[]> {
    const r = await this.db.request().query(`select s.session_id as pid, s.status as state, s.program_name as app, datediff(second, t.transaction_begin_time, sysdatetime()) as open_for, left(coalesce(c.text, ''), 160) as query
      from sys.dm_tran_session_transactions st join sys.dm_tran_active_transactions t on t.transaction_id = st.transaction_id
      join sys.dm_exec_sessions s on s.session_id = st.session_id left join sys.dm_exec_connections cn on cn.session_id = s.session_id outer apply sys.dm_exec_sql_text(cn.most_recent_sql_handle) c
      where datediff(second, t.transaction_begin_time, sysdatetime()) > 30 and s.session_id <> @@spid`).catch(() => ({ recordset: [] as any[] }))
    return r.recordset.map((x: any) => ({ pid: x.pid, state: x.state ?? null, application: x.app || null, openForSeconds: x.open_for ?? null, query: x.query ?? '' }))
  }

  async simulate(migrations: Migration[], _options: SimulateOptions): Promise<MigrationSimulation[]> {
    return staticSimulation(migrations, 'mssql')
  }

  async apply(m: Migration, user: string, options: SimulateOptions): Promise<ApplyResult> {
    const batches = parseScript(m.sql, 'mssql')
    const started = Date.now()
    await this.db.request().input('v', m.version).input('n', m.name).input('c', m.checksum).input('u', user).query(
      `merge ${HISTORY} as t using (select @v as version) s on t.version = s.version
       when matched then update set name = @n, checksum = @c, status = 'running', baselined = 0, started_at = sysutcdatetime(), finished_at = null, duration_ms = null, applied_by = @u, error = null
       when not matched then insert (version, name, checksum, status, started_at, applied_by) values (@v, @n, @c, 'running', sysutcdatetime(), @u);`)
    const tx = new sql.Transaction(this.db)
    await tx.begin()
    try {
      const got = await new sql.Request(tx).query(`declare @r int; exec @r = sp_getapplock @Resource = '${LOCK_RESOURCE}', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 0; select @r as r`)
      if ((got.recordset[0]?.r ?? -1) < 0) throw new ConcurrentRunError()
      await new sql.Request(tx).batch(`set lock_timeout ${Math.floor(options.lockTimeoutMs)}`)
      for (const b of batches) await new sql.Request(tx).batch(b.text)
      await new sql.Request(tx).input('v', m.version).input('ms', Date.now() - started).query(`update ${HISTORY} set status = 'completed', finished_at = sysutcdatetime(), duration_ms = @ms where version = @v`)
      await tx.commit()
    } catch (e) {
      await tx.rollback().catch(() => undefined)
      await this.db.request().input('v', m.version).input('ms', Date.now() - started).input('e', (e as Error).message)
        .query(`update ${HISTORY} set status = 'failed', finished_at = sysutcdatetime(), duration_ms = @ms, error = @e where version = @v`)
      throw e
    }
    return { durationMs: Date.now() - started, partial: false }
  }
}

export { LOCK_RESOURCE }
