import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { Engine } from '../src/engine.js'
import type { ConsoleConfig } from '../src/types.js'

/** The engine with the real Postgres driver, end to end. Needs TEST_DATABASE_URL (see postgres.integration.test.ts). */
const ADMIN_URL = process.env.TEST_DATABASE_URL
const d = ADMIN_URL ? describe : describe.skip

const dir = mkdtempSync(join(tmpdir(), 'mc-e2e-'))
const FILES: Record<string, string> = {
  '20261001000000_orders.sql': `create table public.orders (id int primary key, total numeric not null default 0);`,
  '20261002000000_seed_and_column.sql': `alter table public.orders add column if not exists status text default 'new';\ninsert into public.orders (id, total) values (1, 10), (2, 20);`,
  '20261003000000_audit.sql': `create table public.audit (id serial primary key, note text);`,
}
for (const [f, sql] of Object.entries(FILES)) writeFileSync(join(dir, f), sql)

let devDb = '', prodDb = '', admin: pg.Client
const urlOf = (db: string) => ADMIN_URL!.replace(/\/[^/]*$/, `/${db}`)
const q = async (db: string, sql: string) => { const c = new pg.Client({ connectionString: urlOf(db) }); await c.connect(); try { return (await c.query(sql)).rows } finally { await c.end() } }

const config = (): ConsoleConfig => ({
  migrationsDir: dir, port: 0, host: '127.0.0.1',
  environments: [
    { name: 'dev', driver: 'postgres', url: urlOf(devDb), mode: 'apply', lockTimeoutMs: 1000 },
    { name: 'prod', driver: 'postgres', url: urlOf(prodDb), mode: 'simulate-only', lockTimeoutMs: 1000 },
  ],
})

beforeAll(async () => {
  if (!ADMIN_URL) return
  devDb = `mc_dev_${randomBytes(3).toString('hex')}`; prodDb = `mc_prod_${randomBytes(3).toString('hex')}`
  admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect()
  await admin.query(`create database ${devDb}`); await admin.query(`create database ${prodDb}`)
})
afterAll(async () => {
  if (!ADMIN_URL) return
  await admin.query(`drop database if exists ${devDb} with (force)`); await admin.query(`drop database if exists ${prodDb} with (force)`); await admin.end()
})

d('production: simulate only — see exactly what has to be applied', () => {
  it('shows the full plan for a database that has none of it, and changes nothing', async () => {
    const engine = new Engine(config())
    const s = await engine.status('prod')
    expect(s).toMatchObject({ tracked: false, mode: 'simulate-only' })
    expect(s.migrations.map(m => m.status)).toEqual(['unverified', 'unverified', 'unverified'])

    const plan = await engine.simulate('prod', { versions: s.migrations.map(m => m.version) })
    expect(plan.committed).toBe(false)
    expect(plan.migrations.map(m => [m.version, m.outcome, m.noop])).toEqual([['20261001000000', 'ok', false], ['20261002000000', 'ok', false], ['20261003000000', 'ok', false]])
    expect(plan.migrations[0]!.changes.map(c => `${c.type}:${c.kind}:${c.identity}`)).toEqual(expect.arrayContaining(['added:table:public.orders', 'added:column:public.orders.total']))
    expect(plan.migrations[1]!.changes.map(c => c.identity)).toContain('public.orders.status')
    expect(plan.migrations[1]!.statements.find(s => s.summary.startsWith('INSERT'))?.rowCount).toBe(2)
    expect(plan.migrations[2]!.changes.map(c => c.identity)).toEqual(expect.arrayContaining(['public.audit', 'public.audit.id', 'public.audit.note']))

    expect(await q(prodDb, `select to_regclass('public.orders') as t, to_regclass('migration_console.history') as h`)).toEqual([{ t: null, h: null }])
  })

  it('refuses every way of changing it', async () => {
    const engine = new Engine(config())
    await engine.simulate('prod', { versions: ['20261001000000'] })
    await expect(engine.apply('prod', { version: '20261001000000', confirm: '20261001000000', user: 'ana' })).rejects.toMatchObject({ code: 'simulate_only' })
    await expect(engine.init('prod')).rejects.toMatchObject({ code: 'simulate_only' })
    expect(await q(prodDb, `select to_regclass('public.orders') as t, to_regclass('migration_console.history') as h`)).toEqual([{ t: null, h: null }])
  })

  it('what was already applied by hand shows up as failing (re-running it is not safe), not as pending', async () => {
    await q(prodDb, `create table public.orders (id int primary key, total numeric not null default 0); alter table public.orders add column status text default 'new'; insert into public.orders (id, total) values (1, 10), (2, 20)`)
    const plan = await new Engine(config()).simulate('prod', { versions: ['20261001000000', '20261002000000', '20261003000000'] })
    // 1: `create table` without IF NOT EXISTS fails, which also tells the truth: it is not safe to re-run.
    expect(plan.migrations.map(m => m.outcome)).toEqual(['failed', 'skipped', 'skipped'])
    expect(plan.migrations[0]!.error).toMatch(/42P07/)
    const second = await new Engine(config()).simulate('prod', { versions: ['20261002000000'] })
    expect(second.migrations[0]).toMatchObject({ outcome: 'failed' })           // the rows are already there
    expect(second.migrations[0]!.error).toMatch(/23505/)
    // An idempotent script that is already applied is the case that reads as "nothing left":
    const third = await new Engine(config()).simulate('prod', { versions: ['20261003000000'] })
    expect(third.migrations[0]).toMatchObject({ outcome: 'ok', noop: false })   // `audit` does not exist yet: it WOULD be created
  })
})

d('an environment that applies: simulate, confirm, apply — in order', () => {
  it('walks the whole flow', async () => {
    const engine = new Engine(config())

    expect((await engine.status('dev')).tracked).toBe(false)
    await expect(engine.apply('dev', { version: '20261001000000', confirm: '20261001000000', user: 'ana' })).rejects.toMatchObject({ code: 'simulation_required' })

    await engine.simulate('dev', { versions: ['20261001000000'] })
    await expect(engine.apply('dev', { version: '20261001000000', confirm: '20261001000000', user: 'ana' })).rejects.toMatchObject({ code: 'not_tracked' })

    await engine.init('dev')
    expect((await engine.status('dev')).migrations.map(m => m.status)).toEqual(['pending', 'pending', 'pending'])

    // pending ones are simulated by default, as a chain
    const plan = await engine.simulate('dev')
    expect(plan.migrations).toHaveLength(3)
    expect(plan.migrations.every(m => m.outcome === 'ok')).toBe(true)

    // order is enforced: the second cannot jump the first
    await expect(engine.apply('dev', { version: '20261002000000', confirm: '20261002000000', user: 'ana' })).rejects.toMatchObject({ code: 'out_of_order' })

    for (const v of ['20261001000000', '20261002000000', '20261003000000']) {
      await engine.simulate('dev', { versions: [v] })
      const r = await engine.apply('dev', { version: v, confirm: v, user: 'ana' })
      expect(r.version).toBe(v)
    }
    const done = await engine.status('dev')
    expect(done.migrations.map(m => m.status)).toEqual(['completed', 'completed', 'completed'])
    expect(done.migrations[0]).toMatchObject({ appliedBy: 'ana' })
    expect(await q(devDb, `select count(*)::int as n from public.orders`)).toEqual([{ n: 2 }])

    // already applied ones simulate as "nothing left" for the structure, and cannot be applied twice
    await expect(engine.apply('dev', { version: '20261001000000', confirm: '20261001000000', user: 'ana' })).rejects.toMatchObject({ code: 'simulation_required' })

    // editing an applied script is noticed
    writeFileSync(join(dir, '20261003000000_audit.sql'), FILES['20261003000000_audit.sql']! + '\n-- edited later')
    expect((await engine.status('dev')).migrations[2]!.status).toBe('modified')
    writeFileSync(join(dir, '20261003000000_audit.sql'), FILES['20261003000000_audit.sql']!)
  })

  it('a migration that fails when applied is shown as failed with the error, and nothing of it remains', async () => {
    const db = `mc_fail_${randomBytes(3).toString('hex')}`
    await admin.query(`create database ${db}`)
    try {
      const cfg = config(); cfg.environments = [{ name: 'dev', driver: 'postgres', url: urlOf(db), mode: 'apply', lockTimeoutMs: 1000 }]
      const dir2 = mkdtempSync(join(tmpdir(), 'mc-e2e-fail-')); cfg.migrationsDir = dir2
      writeFileSync(join(dir2, '20261001000000_ok.sql'), 'create table public.fine (id int);')
      // Passes the simulation (it only fails once the data is there), then fails for real.
      writeFileSync(join(dir2, '20261002000000_bad.sql'), `create table public.half (id int); select 1/0;`)
      const engine = new Engine(cfg)
      await engine.init('dev')
      await engine.simulate('dev', { versions: ['20261001000000'] }); await engine.apply('dev', { version: '20261001000000', confirm: '20261001000000', user: 'ana' })
      const sim = await engine.simulate('dev', { versions: ['20261002000000'] })
      expect(sim.migrations[0]).toMatchObject({ outcome: 'failed' })
      await expect(engine.apply('dev', { version: '20261002000000', confirm: '20261002000000', user: 'ana' })).rejects.toMatchObject({ code: 'simulation_required' })   // a failed simulation does not unlock it
      expect((await q(db, `select to_regclass('public.half') as t`))[0].t).toBeNull()
    } finally { await admin.query(`drop database if exists ${db} with (force)`) }
  })
})
