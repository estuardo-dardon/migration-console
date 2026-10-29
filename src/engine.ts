import type { ConsoleConfig, EnvironmentConfig, EnvironmentStatus, HistoryRow, Migration, MigrationRow, Note, SimulationResult } from './types.js'
import { createDriver } from './drivers/index.js'
import { ConcurrentRunError, type Driver } from './drivers/driver.js'
import { parseScript, touchedTables } from './sql/analyze.js'
import { readMigrations } from './source.js'

export class ConsoleError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message) }
}

/** What was last simulated cleanly, by environment + version + checksum. A migration is applied only after one of these. */
const SIMULATION_TTL_MS = 30 * 60 * 1000
const MAX_VERSIONS_PER_SIMULATION = 100

export const DEFAULT_LIMITS = {
  simulate: { lockTimeoutMs: 3_000, statementTimeoutMs: 60_000 },
  apply: { lockTimeoutMs: 5_000, statementTimeoutMs: 300_000 },
}

/** The status of each file given what the history table says (pure). `history === null`: no history table here. */
export function deriveRows(migrations: readonly Migration[], history: readonly HistoryRow[] | null): MigrationRow[] {
  const byVersion = new Map((history ?? []).map(h => [h.version, h]))
  return migrations.map(m => {
    const h = byVersion.get(m.version)
    const base = { version: m.version, name: m.name, file: m.file, checksum: m.checksum, baselined: h?.baselined ?? false, appliedAt: h?.finishedAt ?? null, appliedBy: h?.appliedBy ?? null, durationMs: h?.durationMs ?? null, error: h?.error ?? null }
    if (history === null) return { ...base, status: 'unverified' as const }
    if (!h) return { ...base, status: 'pending' as const }
    if (h.status === 'running') return { ...base, status: 'running' as const }
    if (h.status === 'failed') return { ...base, status: 'failed' as const }
    // A baselined migration was applied by hand, so its checksum is whatever the file was when it was marked.
    return { ...base, status: h.checksum !== m.checksum ? ('modified' as const) : ('completed' as const) }
  })
}

export class Engine {
  private readonly simulated = new Map<string, number>()

  constructor(
    private readonly config: ConsoleConfig,
    private readonly makeDriver: (env: EnvironmentConfig) => Driver = createDriver,
    private readonly now: () => number = Date.now,
  ) {}

  environments() {
    return this.config.environments.map(e => ({ name: e.name, driver: e.driver, mode: e.mode }))
  }

  private env(name: string): EnvironmentConfig {
    const env = this.config.environments.find(e => e.name === name)
    if (!env) throw new ConsoleError(404, 'environment_not_found', `There is no environment "${name}"`, { environment: name })
    return env
  }

  private migrations(): Migration[] {
    try { return readMigrations(this.config.migrationsDir) } catch (e) { throw new ConsoleError(500, 'migrations_unreadable', (e as Error).message) }
  }

  private async withDriver<T>(env: EnvironmentConfig, fn: (d: Driver) => Promise<T>): Promise<T> {
    const driver = this.makeDriver(env)
    try { await driver.connect() } catch (e) { throw new ConsoleError(502, 'connection_failed', `Cannot connect to ${env.name}: ${(e as Error).message}`, { environment: env.name, cause: (e as Error).message }) }
    try { return await fn(driver) } finally { await driver.close() }
  }

  async status(envName: string): Promise<EnvironmentStatus> {
    const env = this.env(envName)
    const migrations = this.migrations()
    return this.withDriver(env, async d => {
      const history = await d.readHistory()
      return {
        environment: env.name, driver: env.driver, mode: env.mode, tracked: history !== null,
        migrations: deriveRows(migrations, history),
        simulation: d.capabilities.catalogDiff ? 'transactional-diff' : 'static',
      }
    })
  }

  /**
   * Show exactly what the chosen migrations would do to this database — executing them in a transaction that is rolled
   * back (Postgres) or reading them (other databases). Nothing is ever committed.
   */
  async simulate(envName: string, options: { versions?: string[] } = {}): Promise<SimulationResult> {
    const env = this.env(envName)
    const all = this.migrations()
    return this.withDriver(env, async d => {
      let versions = options.versions
      if (!versions) {
        const history = await d.readHistory()
        if (history === null) throw new ConsoleError(400, 'versions_required', 'This environment has no history yet: choose which migrations to simulate.')
        versions = deriveRows(all, history).filter(r => r.status === 'pending' || r.status === 'failed' || r.status === 'modified').map(r => r.version)
      }
      if (versions.length === 0) throw new ConsoleError(400, 'nothing_to_simulate', 'There is nothing pending to simulate.')
      if (versions.length > MAX_VERSIONS_PER_SIMULATION) throw new ConsoleError(400, 'too_many', `Simulate at most ${MAX_VERSIONS_PER_SIMULATION} migrations at a time.`, { max: MAX_VERSIONS_PER_SIMULATION })
      const chosen = new Set(versions)
      const unknown = versions.filter(v => !all.some(m => m.version === v))
      if (unknown.length) throw new ConsoleError(404, 'migration_not_found', `Unknown migration(s): ${unknown.join(', ')}`, { versions: unknown.join(', ') })
      const selected = all.filter(m => chosen.has(m.version))

      const started = this.now()
      const limits = { lockTimeoutMs: env.lockTimeoutMs ?? DEFAULT_LIMITS.simulate.lockTimeoutMs, statementTimeoutMs: env.statementTimeoutMs ?? DEFAULT_LIMITS.simulate.statementTimeoutMs }
      const tables = selected.flatMap(m => touchedTables(parseScript(m.sql, env.driver), env.driver))
      const blockers = await d.blockers([...new Set(tables)]).catch(() => [])
      const migrations = await d.simulate(selected, limits)

      for (const m of migrations) {
        if (m.outcome !== 'ok') continue
        const file = selected.find(s => s.version === m.version)!
        this.simulated.set(`${env.name}|${file.version}|${file.checksum}`, this.now())
      }

      const notes: Note[] = []
      if (d.capabilities.catalogDiff) {
        notes.push({ code: 'rolled-back' })
        notes.push({ code: 'same-locks', params: { seconds: Math.round(limits.lockTimeoutMs / 1000) } })
        notes.push({ code: 'no-undo-outside' })
      } else {
        notes.push({ code: 'static-only' })
      }
      if (env.mode === 'apply') notes.push({ code: 'simulate-first' })
      return { environment: env.name, mode: d.capabilities.catalogDiff ? 'transactional-diff' : 'static', startedAt: new Date(started).toISOString(), durationMs: this.now() - started, committed: false, migrations, blockers, notes }
    })
  }

  async init(envName: string) {
    const env = this.requireApply(envName)
    await this.withDriver(env, d => d.initHistory())
  }

  /** Record migrations up to `upTo` as already applied (by hand), without running anything. */
  async baseline(envName: string, options: { upTo: string; confirm: string; user: string }) {
    const env = this.requireApply(envName)
    const all = this.migrations()
    if (!all.some(m => m.version === options.upTo)) throw new ConsoleError(404, 'migration_not_found', `Unknown migration ${options.upTo}`, { versions: options.upTo })
    if (options.confirm !== options.upTo) throw new ConsoleError(400, 'confirmation_mismatch', 'Type the version to confirm.')
    return this.withDriver(env, async d => {
      const history = await d.readHistory()
      const done = new Set((history ?? []).map(h => h.version))
      const toMark = all.filter(m => m.version <= options.upTo && !done.has(m.version))
      await d.baseline(toMark, options.user)
      return { marked: toMark.length }
    })
  }

  async apply(envName: string, options: { version: string; confirm: string; user: string }) {
    const env = this.requireApply(envName)
    const all = this.migrations()
    const m = all.find(x => x.version === options.version)
    if (!m) throw new ConsoleError(404, 'migration_not_found', `Unknown migration ${options.version}`, { versions: options.version })
    if (options.confirm !== m.version) throw new ConsoleError(400, 'confirmation_mismatch', 'The confirmation does not match the migration version.')

    const stamp = this.simulated.get(`${env.name}|${m.version}|${m.checksum}`)
    if (stamp === undefined || this.now() - stamp > SIMULATION_TTL_MS) {
      throw new ConsoleError(409, 'simulation_required', 'Simulate this migration first (a clean simulation is valid for 30 minutes, and for this exact file).')
    }

    return this.withDriver(env, async d => {
      const history = await d.readHistory()
      if (history === null) throw new ConsoleError(409, 'not_tracked', 'This environment has no history yet: initialise it or mark the existing migrations as applied first.')
      const rows = deriveRows(all, history)
      const self = rows.find(r => r.version === m.version)!
      if (self.status === 'completed') throw new ConsoleError(409, 'already_applied', 'This migration is already applied.')
      if (self.status === 'running') throw new ConsoleError(409, 'already_running', 'This migration is marked as running.')
      const earlier = rows.find(r => r.version < m.version && r.status !== 'completed')
      if (earlier) throw new ConsoleError(409, 'out_of_order', `Apply ${earlier.version} (${earlier.status}) first: migrations go in order.`, { blocking: earlier.version, status: earlier.status })
      const limits = { lockTimeoutMs: env.lockTimeoutMs ?? DEFAULT_LIMITS.apply.lockTimeoutMs, statementTimeoutMs: env.statementTimeoutMs ?? DEFAULT_LIMITS.apply.statementTimeoutMs }
      try {
        const r = await d.apply(m, options.user, limits)
        this.simulated.delete(`${env.name}|${m.version}|${m.checksum}`)
        return { version: m.version, durationMs: r.durationMs, partial: r.partial }
      } catch (e) {
        if (e instanceof ConcurrentRunError) throw new ConsoleError(409, 'concurrent_run', e.message)
        throw new ConsoleError(500, 'apply_failed', `Migration ${m.version} failed: ${(e as Error).message}`, { version: m.version, cause: (e as Error).message })
      }
    })
  }

  private requireApply(envName: string): EnvironmentConfig {
    const env = this.env(envName)
    if (env.mode !== 'apply') throw new ConsoleError(403, 'simulate_only', `The environment "${env.name}" is simulation-only: nothing can be applied from here.`, { environment: env.name })
    return env
  }
}
