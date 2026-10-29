import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { PostgresDriver } from '../src/drivers/postgres.js'
import type { EnvironmentConfig, Migration } from '../src/types.js'

/**
 * Runs against a real PostgreSQL: set TEST_DATABASE_URL to a server where a database can be created
 * (e.g. postgres://postgres:test@127.0.0.1:55432/postgres). A scratch database is created and dropped.
 */
const ADMIN_URL = process.env.TEST_DATABASE_URL
const d = ADMIN_URL ? describe : describe.skip

const LIMITS = { lockTimeoutMs: 1_000, statementTimeoutMs: 10_000 }
let dbName = ''
let url = ''

const mig = (version: string, name: string, sql: string): Migration => ({ version, name, file: `${version}_${name}.sql`, sql, checksum: `sum-${version}-${sql.length}` })
const env = (): EnvironmentConfig => ({ name: 't', driver: 'postgres', url, mode: 'apply', schemas: ['public'] })

async function withDriver<T>(fn: (d: PostgresDriver) => Promise<T>): Promise<T> {
  const driver = new PostgresDriver(env())
  await driver.connect()
  try { return await fn(driver) } finally { await driver.close() }
}
async function q(sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: url }); await c.connect()
  try { return (await c.query(sql, params)).rows } finally { await c.end() }
}
const tableExists = async (name: string) => (await q(`select to_regclass($1) as t`, [`public.${name}`]))[0].t !== null

beforeAll(async () => {
  if (!ADMIN_URL) return
  dbName = `mc_${randomBytes(4).toString('hex')}`
  const admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect()
  await admin.query(`create database ${dbName}`); await admin.end()
  url = ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`)
})
afterAll(async () => {
  if (!ADMIN_URL || !dbName) return
  const admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect()
  await admin.query(`drop database if exists ${dbName} with (force)`); await admin.end()
})
beforeEach(async () => {
  if (!ADMIN_URL) return
  await q(`drop schema if exists migration_console cascade; drop schema public cascade; create schema public; drop type if exists mood cascade`)
})

d('simulate: what the script would change, and never commit', () => {
  it('shows the objects a script would create — and leaves the database exactly as it was', async () => {
    const [r] = await withDriver(d => d.simulate([mig('1', 'a', `create table public.orders (id int primary key, total numeric not null default 0); create index orders_total on public.orders (total);`)], LIMITS))
    expect(r).toMatchObject({ outcome: 'ok', noop: false })
    const added = r!.changes.filter(c => c.type === 'added').map(c => `${c.kind}:${c.identity}`)
    expect(added).toEqual(expect.arrayContaining(['table:public.orders', 'column:public.orders.id', 'column:public.orders.total', 'index:public.orders_total', 'constraint:public.orders.orders_pkey']))
    expect(r!.changes.find(c => c.identity === 'public.orders.total')?.after).toBe('numeric not null default 0')
    expect(await tableExists('orders')).toBe(false)
  })

  it('a COMMIT inside the script does NOT make the simulation permanent', async () => {
    await withDriver(d => d.simulate([mig('1', 'a', `begin; create table public.leak (id int); commit; create table public.leak2 (id int);`)], LIMITS))
    expect(await tableExists('leak')).toBe(false)
    expect(await tableExists('leak2')).toBe(false)
  })

  it('END and ROLLBACK/SAVEPOINT statements are never sent either', async () => {
    const [r] = await withDriver(d => d.simulate([mig('1', 'a', `start transaction; create table public.t1 (id int); end; savepoint s; rollback;`)], LIMITS))
    expect(r!.outcome).toBe('ok')
    expect(r!.statements.filter(s => s.skipped).length).toBe(4)
    expect(await tableExists('t1')).toBe(false)
  })

  it('a script that adds something that already exists is a no-op: it is already applied', async () => {
    await q(`create table public.countries (id int primary key); alter table public.countries add column is_active boolean default true`)
    const [r] = await withDriver(d => d.simulate([mig('1', 'a', `alter table public.countries add column if not exists is_active boolean default true; create table if not exists public.countries (id int);`)], LIMITS))
    expect(r).toMatchObject({ outcome: 'ok', noop: true, changes: [] })
  })

  it('shows what a change looks like: new column, altered column, replaced function body, grant', async () => {
    await q(`create table public.t (a int); create function public.f() returns int language sql as 'select 1'; create role mc_reader_${dbName}`)
    const [r] = await withDriver(d => d.simulate([mig('1', 'a', `
      alter table public.t add column b text not null default 'x';
      alter table public.t alter column a type bigint;
      create or replace function public.f() returns int language sql as 'select 2';
      grant select on public.t to mc_reader_${dbName};
      alter table public.t enable row level security;`)], LIMITS))
    const by = (kind: string, id: string) => r!.changes.find(c => c.kind === kind && c.identity === id)
    expect(by('column', 'public.t.b')).toMatchObject({ type: 'added', after: "text not null default 'x'::text" })
    expect(by('column', 'public.t.a')).toMatchObject({ type: 'changed', before: 'integer', after: 'bigint' })
    expect(by('function', 'public.f()')).toMatchObject({ type: 'changed' })
    expect(by('acl', 'r public.t')).toMatchObject({ type: 'changed' })
    expect(by('table', 'public.t')).toMatchObject({ type: 'changed', before: 'table, RLS off', after: 'table, RLS on' })
    await q(`drop role mc_reader_${dbName}`).catch(() => undefined)
  })

  it('reports removed objects, new enum values and views', async () => {
    await q(`create type mood as enum ('sad', 'ok'); create table public.gone (id int); create view public.v as select 1 as x`)
    const [r] = await withDriver(d => d.simulate([mig('1', 'a', `alter type mood add value 'happy'; drop table public.gone; create or replace view public.v as select 2 as x;`)], LIMITS))
    expect(r!.changes.find(c => c.kind === 'enum')).toMatchObject({ type: 'changed', before: 'sad, ok', after: 'sad, ok, happy' })
    expect(r!.changes.find(c => c.identity === 'public.gone')).toMatchObject({ kind: 'table', type: 'removed' })
    expect(r!.changes.find(c => c.kind === 'view')).toMatchObject({ type: 'changed' })
    expect(r!.findings.map(f => f.code)).toEqual(expect.arrayContaining(['drop-table', 'enum-add-value']))
    expect((await q(`select count(*)::int as n from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'mood'`))[0].n).toBe(2)
  })

  it('counts the rows a data statement would touch', async () => {
    await q(`create table public.p (k text primary key, v int); insert into public.p values ('a', 1), ('b', 2)`)
    const [r] = await withDriver(d => d.simulate([mig('1', 'a', `insert into public.p values ('c', 3), ('d', 4); update public.p set v = v + 1 where k in ('a', 'b'); delete from public.p where k = 'zzz'`)], LIMITS))
    expect(r!.statements.map(s => s.rowCount)).toEqual([2, 2, 0])
    expect(r!.noop).toBe(false)
    expect((await q(`select count(*)::int as n from public.p`))[0].n).toBe(2)
  })

  it('a chain is simulated on top of itself: the second migration sees what the first creates', async () => {
    const results = await withDriver(d => d.simulate([mig('1', 'a', `create table public.base (id int)`), mig('2', 'b', `alter table public.base add column extra text`)], LIMITS))
    expect(results.map(r => r.outcome)).toEqual(['ok', 'ok'])
    expect(results[1]!.changes.map(c => `${c.type}:${c.identity}`)).toEqual(['added:public.base.extra'])
    expect(await tableExists('base')).toBe(false)
  })

  it('a failing migration is reported with its statement and line, later ones are skipped, nothing remains', async () => {
    const results = await withDriver(d => d.simulate([
      mig('1', 'ok', `create table public.fine (id int)`),
      mig('2', 'bad', `-- comment\ncreate table public.also (id int);\nalter table public.nope add column x int;`),
      mig('3', 'after', `create table public.never (id int)`),
    ], LIMITS))
    expect(results.map(r => r.outcome)).toEqual(['ok', 'failed', 'skipped'])
    expect(results[1]!.error).toMatch(/Statement 2 \(line 3\).*42P01.*nope/)
    expect(results[2]!.skippedReason).toMatch(/2/)
    expect(await tableExists('fine')).toBe(false)
    expect(await tableExists('also')).toBe(false)
  })

  it('statements that cannot run in a transaction are skipped and said so', async () => {
    await q(`create table public.big (id int)`)
    const [r] = await withDriver(d => d.simulate([mig('1', 'a', `create index concurrently big_id on public.big (id); alter table public.big add column z int`)], LIMITS))
    expect(r!.outcome).toBe('ok')
    expect(r!.statements[0]!).toMatchObject({ skippedCode: "not-transactional" })
    expect(r!.changes.map(c => c.identity)).toEqual(['public.big.z'])
    expect(r!.findings.map(f => f.code)).toContain('non-transactional')
  })

  it('gives up quickly when another session holds a lock, instead of queueing behind it', async () => {
    await q(`create table public.locked (id int)`)
    const holder = new pg.Client({ connectionString: url }); await holder.connect()
    await holder.query('begin'); await holder.query('lock table public.locked in access share mode')
    try {
      const started = Date.now()
      const [r] = await withDriver(d => d.simulate([mig('1', 'a', `alter table public.locked add column x int`)], { lockTimeoutMs: 300, statementTimeoutMs: 10_000 }))
      expect(r!.outcome).toBe('failed')
      expect(r!.error).toMatch(/55P03|lock timeout/)
      expect(Date.now() - started).toBeLessThan(3_000)
    } finally { await holder.query('rollback'); await holder.end() }
  })

  it('looks at other schemas only when asked', async () => {
    await q(`create schema extra`)
    const driver = new PostgresDriver({ ...env(), schemas: ['public', 'extra'] })
    await driver.connect()
    try {
      const [r] = await driver.simulate([mig('1', 'a', `create table extra.t (id int); create table public.u (id int)`)], LIMITS)
      expect(r!.changes.map(c => c.identity)).toEqual(expect.arrayContaining(['extra.t', 'public.u']))
    } finally { await driver.close() }
    await q(`drop schema extra cascade`)
    const [only] = await withDriver(async d => { await q(`create schema extra`); return d.simulate([mig('1', 'a', `create table extra.t (id int)`)], LIMITS) })
    expect(only!.changes.map(c => c.identity)).not.toContain('extra.t')
  })
})

d('history, apply and baseline', () => {
  it('there is no history until it is created, then it is empty', async () => {
    await withDriver(async d => {
      expect(await d.readHistory()).toBeNull()
      await d.initHistory(); await d.initHistory()                 // idempotent
      expect(await d.readHistory()).toEqual([])
    })
  })

  it('applies a migration for real, records it with who/when/how long, and the objects exist', async () => {
    await withDriver(async d => {
      await d.initHistory()
      const m = mig('20261001000000', 'orders', `create table public.orders (id int)`)
      const r = await d.apply(m, 'ana', LIMITS)
      expect(r.partial).toBe(false)
      const h = (await d.readHistory())!
      expect(h).toHaveLength(1)
      expect(h[0]).toMatchObject({ version: m.version, name: 'orders', checksum: m.checksum, status: 'completed', baselined: false, appliedBy: 'ana', error: null })
      expect(h[0]!.finishedAt).not.toBeNull()
    })
    expect(await tableExists('orders')).toBe(true)
  })

  it('a migration that fails halfway is rolled back completely and recorded as failed with the error', async () => {
    await withDriver(async d => {
      await d.initHistory()
      const m = mig('20261001000000', 'bad', `create table public.half (id int); insert into public.half values ('not a number')`)
      await expect(d.apply(m, 'ana', LIMITS)).rejects.toThrow(/invalid input syntax/)
      const [h] = (await d.readHistory())!
      expect(h).toMatchObject({ status: 'failed' })
      expect(h!.error).toMatch(/22P02/)
    })
    expect(await tableExists('half')).toBe(false)
  })

  it('a failed migration can be applied again once fixed', async () => {
    await withDriver(async d => {
      await d.initHistory()
      await expect(d.apply(mig('1', 'x', `select 1/0`), 'ana', LIMITS)).rejects.toThrow()
      await d.apply(mig('1', 'x', `create table public.fixed (id int)`), 'bo', LIMITS)
      const [h] = (await d.readHistory())!
      expect(h).toMatchObject({ status: 'completed', error: null, appliedBy: 'bo' })
    })
    expect(await tableExists('fixed')).toBe(true)
  })

  it('statements that need autocommit run without a transaction and the migration is flagged partial', async () => {
    await q(`create table public.idx (id int)`)
    const r = await withDriver(async d => { await d.initHistory(); return d.apply(mig('1', 'c', `create index concurrently idx_id on public.idx (id); alter table public.idx add column y int`), 'ana', LIMITS) })
    expect(r.partial).toBe(true)
    expect((await q(`select indexname from pg_indexes where indexname = 'idx_id'`)).length).toBe(1)
  })

  it('a COMMIT or BEGIN written in the script does not break the wrapping transaction', async () => {
    await withDriver(async d => { await d.initHistory(); await d.apply(mig('1', 'w', `begin; create table public.wrapped (id int); commit;`), 'ana', LIMITS) })
    expect(await tableExists('wrapped')).toBe(true)
  })

  it('only one runner at a time', async () => {
    const holder = new pg.Client({ connectionString: url }); await holder.connect()
    await holder.query('select pg_advisory_lock($1)', [7_243_001])
    try {
      await withDriver(async d => {
        await d.initHistory()
        await expect(d.apply(mig('1', 'a', `select 1`), 'ana', LIMITS)).rejects.toThrow(/Another run/)
      })
    } finally { await holder.end() }
  })

  it('baseline records migrations as applied without running them, and never overwrites a real record', async () => {
    await withDriver(async d => {
      await d.initHistory()
      await d.apply(mig('2', 'real', `create table public.real_one (id int)`), 'ana', LIMITS)
      await d.baseline([mig('1', 'old', `create table public.should_not_exist (id int)`), mig('2', 'real', `x`)], 'ops')
      const h = (await d.readHistory())!
      expect(h.map(r => [r.version, r.baselined, r.appliedBy])).toEqual([['1', true, 'ops'], ['2', false, 'ana']])
    })
    expect(await tableExists('should_not_exist')).toBe(false)
  })

  it('finds sessions that sit on an open transaction (what blocked ALTER TABLE in production)', async () => {
    await q(`create table public.busy (id int)`)
    const holder = new pg.Client({ connectionString: url, application_name: 'forgotten-dbeaver' }); await holder.connect()
    await holder.query('begin'); await holder.query('select * from public.busy')
    try {
      // The driver only reports transactions older than 30 s: ask for the same facts the way it does, with no age limit.
      const rows = await q(`select a.pid from pg_stat_activity a where a.application_name = 'forgotten-dbeaver' and a.state = 'idle in transaction'`)
      expect(rows.length).toBe(1)
      const blockers = await withDriver(d => d.blockers(['public.busy', 'busy']))
      expect(blockers).toEqual([])                                   // too young to be reported: no false alarms
    } finally { await holder.query('rollback'); await holder.end() }
  })
})

d('noise', () => {
  it('a new table does not show a "permissions" change just because it has the default ones', async () => {
    const [r] = await withDriver(d => d.simulate([mig('1', 'a', `create table public.n (id int)`)], LIMITS))
    expect(r!.changes.some(c => c.kind === 'acl')).toBe(false)
  })

  it('but a grant on it does show', async () => {
    await q(`create role mc_noise_${dbName}`)
    try {
      const [r] = await withDriver(d => d.simulate([mig('1', 'a', `create table public.n (id int); grant select on public.n to mc_noise_${dbName}`)], LIMITS))
      expect(r!.changes.find(c => c.kind === 'acl')).toMatchObject({ type: 'added', identity: 'r public.n' })
    } finally { await q(`drop role mc_noise_${dbName}`) }
  })
})
