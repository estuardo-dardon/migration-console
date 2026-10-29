export type DriverName = 'postgres' | 'mysql' | 'mssql'

/**
 * `apply`: migrations can be executed here (after a simulation and an explicit confirmation).
 * `simulate-only`: nothing is ever committed — the console can only show what a script WOULD change (production).
 */
export type EnvMode = 'apply' | 'simulate-only'

export interface EnvironmentConfig {
  name: string
  driver: DriverName
  /** Connection string. `${VAR}` is replaced from the process environment, so secrets stay out of the file. */
  url: string
  mode: EnvMode
  /** Postgres: schemas whose objects are compared before/after a simulation (default: public). */
  schemas?: string[]
  /** Longest a statement may wait for a lock before it gives up, instead of queueing everyone behind it. */
  lockTimeoutMs?: number
  statementTimeoutMs?: number
}

export interface ConsoleConfig {
  migrationsDir: string
  port: number
  host: string
  environments: EnvironmentConfig[]
}

export interface Migration {
  /** The leading digits of the file name (e.g. 20261108000000). Sorted as text. */
  version: string
  name: string
  file: string
  sql: string
  /** sha256 of the file; a change after it was applied marks it `modified`. */
  checksum: string
}

export type MigrationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'modified' | 'unverified'

export interface HistoryRow {
  version: string
  name: string
  checksum: string
  status: 'running' | 'completed' | 'failed'
  baselined: boolean
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  appliedBy: string | null
  error: string | null
}

export interface MigrationRow {
  version: string
  name: string
  file: string
  checksum: string
  status: MigrationStatus
  baselined: boolean
  appliedAt: string | null
  appliedBy: string | null
  durationMs: number | null
  error: string | null
}

export interface EnvironmentStatus {
  environment: string
  driver: DriverName
  mode: EnvMode
  /** false: the history table does not exist yet (nothing was ever applied through the console here). */
  tracked: boolean
  migrations: MigrationRow[]
  /** Capabilities of this driver: what a simulation can tell. */
  simulation: 'transactional-diff' | 'static'
}

/**
 * A message the clients translate: `code` is a key of the catalogs in `src/ui/locales`, `params` fill its placeholders.
 * The plain-text field next to it is an English fallback for logs and scripts.
 */
export interface Note {
  code: string
  params?: Record<string, string | number>
}

export type FindingLevel = 'info' | 'warning' | 'danger'

export interface Finding {
  level: FindingLevel
  code: string
  message: string
  /** 1-based number of the statement inside the script. */
  statement: number
  line: number
}

export type StatementKind = 'ddl' | 'dml' | 'query' | 'transaction-control' | 'other'

export interface ParsedStatement {
  index: number
  text: string
  /** 1-based line where it starts. */
  line: number
  kind: StatementKind
  /** First words, for display: `ALTER TABLE public.countries`. */
  summary: string
  /** Cannot run inside a transaction (CREATE INDEX CONCURRENTLY, VACUUM…): a simulation skips it and says so. */
  nonTransactional: boolean
}

export type ChangeType = 'added' | 'removed' | 'changed'

export interface Change {
  /** table, column, index, constraint, function, trigger, policy, enum, view, acl, extension, schema */
  kind: string
  identity: string
  type: ChangeType
  before?: string
  after?: string
}

export interface StatementResult {
  index: number
  line: number
  summary: string
  kind: StatementKind
  /** Rows touched by an INSERT / UPDATE / DELETE. */
  rowCount?: number | null
  skipped?: string
  /** `transaction-control`, `not-transactional` or `failed`. */
  skippedCode?: string
}

export interface MigrationSimulation {
  version: string
  name: string
  outcome: 'ok' | 'failed' | 'skipped'
  error?: string
  /** The translatable form of `error` (`statement-failed`, `script-unreadable`). */
  errorInfo?: Note
  skippedReason?: string
  /** The translatable form of `skippedReason` (`depends-on-failed`). */
  skippedInfo?: Note
  durationMs: number
  statements: StatementResult[]
  findings: Finding[]
  changes: Change[]
  /** Ran cleanly and changes nothing: the database already has what the script would create. */
  noop: boolean
}

export interface Blocker {
  pid: number
  state: string | null
  application: string | null
  openForSeconds: number | null
  query: string
}

export interface SimulationResult {
  environment: string
  mode: 'transactional-diff' | 'static'
  startedAt: string
  durationMs: number
  /** Nothing was committed. Always true: there is no code path that commits a simulation. */
  committed: false
  migrations: MigrationSimulation[]
  blockers: Blocker[]
  notes: Note[]
}
