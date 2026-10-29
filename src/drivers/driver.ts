import type { Change, DriverName, EnvironmentConfig, HistoryRow, Migration, MigrationSimulation, Blocker } from '../types.js'

export interface DriverCapabilities {
  /** The database can run DDL inside a transaction and undo it: a simulation can really execute the script. */
  transactionalDDL: boolean
  /** A simulation can compare the objects of the database before and after each script. */
  catalogDiff: boolean
}

/** Another run holds the apply lock of this database. */
export class ConcurrentRunError extends Error {
  constructor() { super('Another run is applying migrations on this database.') }
}

export interface ApplyResult {
  durationMs: number
  /** Statements that ran outside a transaction: a failure after them is not undone. */
  partial: boolean
}

export interface SimulateOptions {
  lockTimeoutMs: number
  statementTimeoutMs: number
}

/**
 * What the console needs from a database. One instance is one connection, opened for one request and closed after.
 * Only the Postgres driver can execute a script in a transaction and show a catalog diff; the others analyse the
 * script statically (see `capabilities`).
 */
export interface Driver {
  readonly name: DriverName
  readonly capabilities: DriverCapabilities
  connect(): Promise<void>
  close(): Promise<void>
  /** null when the history table does not exist (nothing was applied through the console here). */
  readHistory(): Promise<HistoryRow[] | null>
  /** Create the history table. Only for environments that may apply migrations. */
  initHistory(): Promise<void>
  /** Mark migrations as already applied (they were applied by hand). Writes history rows, runs nothing. */
  baseline(migrations: Migration[], user: string): Promise<void>
  /**
   * Run `migrations` in order inside ONE transaction and ALWAYS roll it back. Never commits.
   * Each migration is simulated on top of the previous ones, so a chain of pending migrations can be checked together.
   */
  simulate(migrations: Migration[], options: SimulateOptions): Promise<MigrationSimulation[]>
  /** Run one migration for real and record it in the history. */
  apply(migration: Migration, user: string, options: SimulateOptions): Promise<ApplyResult>
  /** Long-open transactions that could block a script (a lock queue is what made `ALTER TABLE` hang in production). */
  blockers(tables: string[]): Promise<Blocker[]>
}

export type DriverFactory = (env: EnvironmentConfig) => Driver

export type { Change }
