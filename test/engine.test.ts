import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConsoleError, Engine, deriveRows } from '../src/engine.js'
import type { Driver } from '../src/drivers/driver.js'
import type { ConsoleConfig, HistoryRow, Migration, MigrationSimulation } from '../src/types.js'

const dir = mkdtempSync(join(tmpdir(), 'mc-engine-'))
const files = { '20261001000000_one.sql': 'create table a (x int);', '20261002000000_two.sql': 'create table b (x int);', '20261003000000_three.sql': 'drop table a;' }
for (const [f, sql] of Object.entries(files)) writeFileSync(join(dir, f), sql)

const config: ConsoleConfig = {
  migrationsDir: dir, port: 1, host: '127.0.0.1',
  environments: [
    { name: 'dev', driver: 'postgres', url: 'x', mode: 'apply' },
    { name: 'prod', driver: 'postgres', url: 'x', mode: 'simulate-only' },
  ],
}

const row = (m: Migration, over: Partial<HistoryRow> = {}): HistoryRow => ({ version: m.version, name: m.name, checksum: m.checksum, status: 'completed', baselined: false, startedAt: null, finishedAt: '2026-11-01T00:00:00.000Z', durationMs: 5, appliedBy: 'ana', error: null, ...over })

function fake(history: HistoryRow[] | null | (() => HistoryRow[] | null), simulation?: (m: Migration[]) => MigrationSimulation[]) {
  const calls = { simulate: [] as string[][], apply: [] as string[], baseline: [] as string[][], init: 0, connect: 0, close: 0 }
  const driver: Driver = {
    name: 'postgres', capabilities: { transactionalDDL: true, catalogDiff: true },
    connect: async () => { calls.connect++ }, close: async () => { calls.close++ },
    readHistory: async () => (typeof history === 'function' ? history() : history),
    initHistory: async () => { calls.init++ },
    baseline: async (ms) => { calls.baseline.push(ms.map(m => m.version)) },
    simulate: async ms => { calls.simulate.push(ms.map(m => m.version)); return (simulation ?? (list => list.map(m => ({ version: m.version, name: m.name, outcome: 'ok' as const, durationMs: 1, statements: [], findings: [], changes: [], noop: false }))))(ms) },
    apply: async m => { calls.apply.push(m.version); return { durationMs: 7, partial: false } },
    blockers: async () => [],
  }
  return { driver, calls }
}

const all = () => Object.keys(files).map(f => { const m = /^(\d+)_(.+)\.sql$/.exec(f)!; return { version: m[1]!, name: m[2]!, file: f, sql: (files as any)[f], checksum: '' } })

let migrations: Migration[]
beforeEach(async () => {
  const { readMigrations } = await import('../src/source.js')
  migrations = readMigrations(dir)
})

describe('deriveRows', () => {
  it('without a history table every migration is unverified', () => {
    expect(deriveRows(migrations, null).map(r => r.status)).toEqual(['unverified', 'unverified', 'unverified'])
  })

  it('maps the history onto the files: completed, failed, running, pending, and modified when the file changed', () => {
    const [a, b, c] = migrations as [Migration, Migration, Migration]
    const rows = deriveRows(migrations, [row(a), row(b, { status: 'failed', error: 'boom' })])
    expect(rows.map(r => r.status)).toEqual(['completed', 'failed', 'pending'])
    expect(rows[1]!.error).toBe('boom')
    expect(deriveRows(migrations, [row(a, { checksum: 'other' })])[0]!.status).toBe('modified')
    expect(deriveRows(migrations, [row(c, { status: 'running' })])[2]!.status).toBe('running')
  })

  it('a baselined migration is shown as such', () => {
    expect(deriveRows(migrations, [row(migrations[0]!, { baselined: true })])[0]).toMatchObject({ status: 'completed', baselined: true })
  })
})

describe('Engine.status', () => {
  it('lists the files with their status and closes the connection', async () => {
    const f = fake([row(migrations[0]!)])
    const s = await new Engine(config, () => f.driver).status('dev')
    expect(s).toMatchObject({ environment: 'dev', mode: 'apply', tracked: true, simulation: 'transactional-diff' })
    expect(s.migrations.map(m => m.status)).toEqual(['completed', 'pending', 'pending'])
    expect(f.calls.close).toBe(1)
  })

  it('an unknown environment is a 404; a connection failure is a 502 with no secret in it', async () => {
    const e = new Engine(config, () => ({ ...fake(null).driver, connect: async () => { throw new Error('ECONNREFUSED') } }))
    await expect(e.status('nope')).rejects.toMatchObject({ status: 404, code: 'environment_not_found' })
    await expect(e.status('dev')).rejects.toMatchObject({ status: 502, code: 'connection_failed' })
    await expect(e.status('dev')).rejects.toThrow(/ECONNREFUSED/)
  })
})

describe('Engine.simulate', () => {
  it('defaults to what is pending when there is a history, in version order', async () => {
    const f = fake([row(migrations[0]!)])
    const r = await new Engine(config, () => f.driver).simulate('dev')
    expect(f.calls.simulate).toEqual([['20261002000000', '20261003000000']])
    expect(r).toMatchObject({ environment: 'dev', committed: false, mode: 'transactional-diff' })
  })

  it('without a history the caller must choose (simulating every file from the start would make no sense)', async () => {
    const f = fake(null)
    await expect(new Engine(config, () => f.driver).simulate('prod')).rejects.toMatchObject({ code: 'versions_required' })
    expect(f.calls.simulate).toEqual([])
  })

  it('simulates the chosen versions in file order whatever order they were sent in, and rejects unknown ones', async () => {
    const f = fake(null)
    const e = new Engine(config, () => f.driver)
    await e.simulate('prod', { versions: ['20261003000000', '20261001000000'] })
    expect(f.calls.simulate).toEqual([['20261001000000', '20261003000000']])
    await expect(e.simulate('prod', { versions: ['999'] })).rejects.toMatchObject({ code: 'migration_not_found' })
    await expect(e.simulate('prod', { versions: [] })).rejects.toMatchObject({ code: 'nothing_to_simulate' })
  })

  it('a simulation-only environment can be simulated', async () => {
    const f = fake(null)
    const r = await new Engine(config, () => f.driver).simulate('prod', { versions: ['20261001000000'] })
    expect(r.environment).toBe('prod')
  })
})

describe('Engine.apply', () => {
  const V1 = '20261001000000', V2 = '20261002000000'

  it('a simulation-only environment can never apply, whatever is asked', async () => {
    const f = fake([])
    const e = new Engine(config, () => f.driver)
    await e.simulate('prod', { versions: [V1] })
    await expect(e.apply('prod', { version: V1, confirm: V1, user: 'ana' })).rejects.toMatchObject({ status: 403, code: 'simulate_only' })
    await expect(e.init('prod')).rejects.toMatchObject({ code: 'simulate_only' })
    await expect(e.baseline('prod', { upTo: V1, confirm: V1, user: 'ana' })).rejects.toMatchObject({ code: 'simulate_only' })
    expect(f.calls.apply).toEqual([]); expect(f.calls.init).toBe(0)
  })

  it('needs a clean simulation of that exact file first', async () => {
    const f = fake([])
    const e = new Engine(config, () => f.driver)
    await expect(e.apply('dev', { version: V1, confirm: V1, user: 'ana' })).rejects.toMatchObject({ status: 409, code: 'simulation_required' })
    expect(f.calls.apply).toEqual([])
  })

  it('a failed simulation does not unlock applying', async () => {
    const f = fake([], ms => ms.map(m => ({ version: m.version, name: m.name, outcome: 'failed' as const, error: 'boom', durationMs: 1, statements: [], findings: [], changes: [], noop: false })))
    const e = new Engine(config, () => f.driver)
    await e.simulate('dev', { versions: [V1] })
    await expect(e.apply('dev', { version: V1, confirm: V1, user: 'ana' })).rejects.toMatchObject({ code: 'simulation_required' })
  })

  it('the simulation expires after 30 minutes', async () => {
    let now = 1_000_000
    const f = fake([])
    const e = new Engine(config, () => f.driver, () => now)
    await e.simulate('dev', { versions: [V1] })
    now += 31 * 60 * 1000
    await expect(e.apply('dev', { version: V1, confirm: V1, user: 'ana' })).rejects.toMatchObject({ code: 'simulation_required' })
  })

  it('the confirmation must be the exact version', async () => {
    const f = fake([])
    const e = new Engine(config, () => f.driver)
    await e.simulate('dev', { versions: [V1] })
    await expect(e.apply('dev', { version: V1, confirm: 'yes', user: 'ana' })).rejects.toMatchObject({ code: 'confirmation_mismatch' })
    expect(f.calls.apply).toEqual([])
  })

  it('applies the oldest pending migration once simulated and confirmed, and the simulation is spent', async () => {
    const f = fake([])
    const e = new Engine(config, () => f.driver)
    await e.simulate('dev', { versions: [V1] })
    expect(await e.apply('dev', { version: V1, confirm: V1, user: 'ana' })).toEqual({ version: V1, durationMs: 7, partial: false })
    expect(f.calls.apply).toEqual([V1])
    await expect(e.apply('dev', { version: V1, confirm: V1, user: 'ana' })).rejects.toMatchObject({ code: 'simulation_required' })
  })

  it('goes in order: a later migration cannot be applied while an earlier one is not completed', async () => {
    const f = fake([])
    const e = new Engine(config, () => f.driver)
    await e.simulate('dev', { versions: [V2] })
    await expect(e.apply('dev', { version: V2, confirm: V2, user: 'ana' })).rejects.toMatchObject({ status: 409, code: 'out_of_order', details: { blocking: V1 } })
    expect(f.calls.apply).toEqual([])
  })

  it('refuses one that is already applied, and one that has no history table yet', async () => {
    const done = fake(() => [row(migrations[0]!)])
    const e = new Engine(config, () => done.driver)
    await e.simulate('dev', { versions: [V1] })
    await expect(e.apply('dev', { version: V1, confirm: V1, user: 'ana' })).rejects.toMatchObject({ code: 'already_applied' })
    const none = fake(null)
    const e2 = new Engine(config, () => none.driver)
    await e2.simulate('dev', { versions: [V1] })
    await expect(e2.apply('dev', { version: V1, confirm: V1, user: 'ana' })).rejects.toMatchObject({ code: 'not_tracked' })
  })

  it('a failure while applying is reported with the migration and nothing is hidden', async () => {
    const f = fake([])
    f.driver.apply = async () => { throw new Error('syntax error at or near "x"') }
    const e = new Engine(config, () => f.driver)
    await e.simulate('dev', { versions: [V1] })
    await expect(e.apply('dev', { version: V1, confirm: V1, user: 'ana' })).rejects.toThrow(/20261001000000.*syntax error/)
  })
})

describe('Engine.baseline', () => {
  it('records as applied only the files up to the chosen version that have no status yet', async () => {
    const f = fake([row(migrations[0]!)])
    const r = await new Engine(config, () => f.driver).baseline('dev', { upTo: '20261002000000', confirm: '20261002000000', user: 'ana' })
    expect(r).toEqual({ marked: 1 })
    expect(f.calls.baseline).toEqual([['20261002000000']])
  })

  it('needs the version typed back', async () => {
    const f = fake([])
    await expect(new Engine(config, () => f.driver).baseline('dev', { upTo: '20261002000000', confirm: 'x', user: 'ana' })).rejects.toMatchObject({ code: 'confirmation_mismatch' })
    expect(f.calls.baseline).toEqual([])
  })
})
