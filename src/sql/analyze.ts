import type { DriverName, Finding, ParsedStatement, StatementKind } from '../types.js'
import { splitStatements, stripComments } from './splitter.js'

const words = (sql: string, n: number) => sql.replace(/\s+/g, ' ').trim().split(' ').slice(0, n).join(' ')

/** What a statement is, from its first words. Good enough to decide how to treat it; the database has the last word. */
export function classify(raw: string, driver: DriverName): { kind: StatementKind; nonTransactional: boolean } {
  const code = stripComments(raw, driver).replace(/\s+/g, ' ').trim().toUpperCase()
  const first = code.split(' ')[0] ?? ''
  if (/^(BEGIN|START TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|SET TRANSACTION|PREPARE TRANSACTION|COMMIT PREPARED|ROLLBACK PREPARED)\b/.test(code) && !/^BEGIN\s+ATOMIC/.test(code)) {
    return { kind: 'transaction-control', nonTransactional: false }
  }
  const nonTransactional =
    /^CREATE (UNIQUE )?INDEX CONCURRENTLY\b/.test(code) || /^DROP INDEX CONCURRENTLY\b/.test(code) || /^REINDEX .*CONCURRENTLY\b/.test(code) ||
    /^(VACUUM|CLUSTER)\b/.test(code) || /^(CREATE|DROP) (DATABASE|TABLESPACE)\b/.test(code) || /^ALTER SYSTEM\b/.test(code) ||
    /^ALTER TABLE .* DETACH PARTITION .* CONCURRENTLY\b/.test(code) || /^REFRESH MATERIALIZED VIEW CONCURRENTLY\b/.test(code)
  if (/^(CREATE|ALTER|DROP|TRUNCATE|COMMENT|GRANT|REVOKE|RENAME|REINDEX|REFRESH|SECURITY LABEL|ANALYZE|CLUSTER|VACUUM)\b/.test(code)) return { kind: 'ddl', nonTransactional }
  if (/^(INSERT|UPDATE|DELETE|MERGE|COPY|REPLACE)\b/.test(code)) return { kind: 'dml', nonTransactional }
  if (/^(SELECT|WITH|VALUES|TABLE|SHOW|EXPLAIN)\b/.test(code)) return { kind: 'query', nonTransactional }
  return { kind: first ? 'other' : 'other', nonTransactional }
}

export function parseScript(sql: string, driver: DriverName): ParsedStatement[] {
  return splitStatements(sql, driver).map((s, i) => {
    const { kind, nonTransactional } = classify(s.text, driver)
    return { index: i + 1, text: s.text, line: s.line, kind, nonTransactional, summary: summarize(s.text, driver) }
  })
}

/** `ALTER TABLE public.countries`, `INSERT INTO public.parameters` … : enough to recognise the statement in a list. */
export function summarize(raw: string, driver: DriverName): string {
  const code = stripComments(raw, driver).replace(/\s+/g, ' ').trim()
  const m = /^(CREATE(?: OR REPLACE)?(?: UNIQUE)?(?: MATERIALIZED)?(?: (?:TEMP|TEMPORARY|UNLOGGED))? (?:TABLE|INDEX|FUNCTION|PROCEDURE|VIEW|TRIGGER|POLICY|TYPE|SCHEMA|EXTENSION|SEQUENCE|DOMAIN|ROLE)(?: CONCURRENTLY)?(?: IF NOT EXISTS)?|ALTER (?:TABLE|TYPE|FUNCTION|INDEX|VIEW|SCHEMA|POLICY|SEQUENCE)(?: IF EXISTS)?(?: ONLY)?|DROP [A-Z ]+?(?: IF EXISTS)?|INSERT INTO|UPDATE|DELETE FROM|TRUNCATE(?: TABLE)?|COMMENT ON [A-Z ]+?|GRANT|REVOKE|COPY)\s+([^\s(;]+)?/i.exec(code)
  if (m) return `${m[1]!.toUpperCase()} ${m[2] ?? ''}`.trim()
  return words(code, 4)
}

export interface Rule {
  code: string
  level: Finding['level']
  test: RegExp
  message: string
  drivers?: DriverName[]
}

export const RULES: Rule[] = [
  { code: 'drop-table', level: 'danger', test: /^DROP (TABLE|SCHEMA|DATABASE)\b/, message: 'Drops a table or schema with all its data.' },
  { code: 'drop-column', level: 'danger', test: /^ALTER TABLE .*\bDROP COLUMN\b/, message: 'Drops a column and its data.' },
  { code: 'drop-other', level: 'warning', test: /^DROP (FUNCTION|VIEW|MATERIALIZED VIEW|TRIGGER|POLICY|TYPE|INDEX|CONSTRAINT|SEQUENCE|EXTENSION|DOMAIN)\b/, message: 'Drops an object: code that uses it will stop working.' },
  { code: 'truncate', level: 'danger', test: /^TRUNCATE\b/, message: 'Empties the table completely.' },
  { code: 'delete-no-where', level: 'danger', test: /^DELETE FROM (?![\s\S]*\bWHERE\b)/, message: 'DELETE without WHERE: deletes every row.' },
  { code: 'update-no-where', level: 'danger', test: /^UPDATE\b(?![\s\S]*\bWHERE\b)/, message: 'UPDATE without WHERE: changes every row.' },
  { code: 'alter-type', level: 'warning', test: /^ALTER TABLE .* ALTER (COLUMN )?\w+ (SET DATA )?TYPE\b/, message: 'Changes a column type: may rewrite the whole table under an exclusive lock.', drivers: ['postgres'] },
  { code: 'set-not-null', level: 'warning', test: /^ALTER TABLE .* SET NOT NULL\b/, message: 'Scans the whole table to check for nulls, under an exclusive lock.', drivers: ['postgres'] },
  { code: 'add-column-volatile-default', level: 'warning', test: /^ALTER TABLE .* ADD (COLUMN )?.*DEFAULT [^;]*(RANDOM|NOW|CLOCK_TIMESTAMP|UUID_GENERATE|GEN_RANDOM_UUID|NEXTVAL)\s*\(/, message: 'A column with a volatile default rewrites the table.', drivers: ['postgres'] },
  { code: 'index-blocks-writes', level: 'warning', test: /^CREATE (UNIQUE )?INDEX (?!CONCURRENTLY)/, message: 'Creating an index without CONCURRENTLY blocks writes to the table while it is built.', drivers: ['postgres'] },
  { code: 'enum-add-value', level: 'warning', test: /^ALTER TYPE .* ADD VALUE\b/, message: 'The new enum value cannot be used in the same transaction that creates it.', drivers: ['postgres'] },
  { code: 'copy-program', level: 'danger', test: /^COPY .* (FROM|TO) PROGRAM\b/, message: 'Runs a command on the database server.', drivers: ['postgres'] },
  { code: 'external-effect', level: 'warning', test: /\b(DBLINK|PG_READ_FILE|PG_LS_DIR|LO_IMPORT|LO_EXPORT|HTTP_POST|HTTP_GET|NET\.HTTP)\w*\s*\(/, message: 'Calls something outside the database: a simulation cannot undo that effect.', drivers: ['postgres'] },
  { code: 'create-extension', level: 'warning', test: /^CREATE EXTENSION\b/, message: 'Installs an extension in the database.', drivers: ['postgres'] },
  { code: 'alter-table-lock', level: 'info', test: /^ALTER TABLE\b/, message: 'Takes a lock on the table while it is applied; it waits if a long transaction is open on it.', drivers: ['postgres'] },
  { code: 'grant-revoke', level: 'info', test: /^(GRANT|REVOKE)\b/, message: 'Changes permissions.' },
  { code: 'security-definer', level: 'info', test: /^CREATE (OR REPLACE )?FUNCTION [\s\S]*\bSECURITY DEFINER\b/, message: 'SECURITY DEFINER function: runs with its owner\'s permissions.', drivers: ['postgres'] },
]

const MYSQL_DDL = /^(CREATE|ALTER|DROP|TRUNCATE|RENAME)\b/

export function analyze(statements: readonly ParsedStatement[], driver: DriverName): Finding[] {
  const findings: Finding[] = []
  for (const s of statements) {
    const code = stripComments(s.text, driver).replace(/\s+/g, ' ').trim().toUpperCase()
    const add = (level: Finding['level'], codeName: string, message: string) => findings.push({ level, code: codeName, message, statement: s.index, line: s.line })
    if (s.kind === 'transaction-control') {
      add('info', 'transaction-control', 'Transaction control (BEGIN / COMMIT…): the console wraps the migration in its own transaction, so it is ignored.')
      continue
    }
    if (s.nonTransactional) add('warning', 'non-transactional', 'Cannot run inside a transaction: the simulation skips it and, when applied, a failure halfway is not undone.')
    if (driver === 'mysql' && MYSQL_DDL.test(code)) add('warning', 'implicit-commit', 'In MySQL, DDL commits the current transaction: it cannot be simulated with a rollback or undone if it fails halfway.')
    for (const r of RULES) {
      if (r.drivers && !r.drivers.includes(driver)) continue
      if (r.test.test(code)) add(r.level, r.code, r.message)
    }
  }
  return findings
}

/**
 * The tables a script touches, as they would appear in the lock table (`public.x` and `x`), to look for sessions that
 * could block it. Heuristic: a miss only means no warning.
 */
export function touchedTables(statements: readonly ParsedStatement[], driver: DriverName): string[] {
  const names = new Set<string>()
  const re = /\b(?:ALTER TABLE(?: IF EXISTS)?(?: ONLY)?|CREATE(?: UNIQUE)? INDEX(?: CONCURRENTLY)?(?: IF NOT EXISTS)?(?: [\w."]+)? ON(?: ONLY)?|INSERT INTO|UPDATE(?: ONLY)?|DELETE FROM(?: ONLY)?|TRUNCATE(?: TABLE)?(?: ONLY)?|DROP TABLE(?: IF EXISTS)?|CREATE TRIGGER [\w."]+ [A-Z ]+ ON|COMMENT ON TABLE)\s+([\w."]+)/gi
  for (const s of statements) {
    const code = stripComments(s.text, driver).replace(/\s+/g, ' ')
    for (const m of code.matchAll(re)) {
      const raw = m[1]!.replace(/"/g, '').toLowerCase()
      if (!raw) continue
      names.add(raw)
      if (raw.startsWith('public.')) names.add(raw.slice('public.'.length))
      else if (!raw.includes('.')) names.add(`public.${raw}`)
    }
  }
  return [...names]
}
