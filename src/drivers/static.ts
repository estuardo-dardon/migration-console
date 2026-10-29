import type { DriverName, Migration, MigrationSimulation, StatementResult } from '../types.js'
import { analyze, parseScript } from '../sql/analyze.js'
import { UnsupportedScriptError } from '../sql/splitter.js'

/**
 * A simulation for databases where DDL cannot be undone by a rollback (MySQL) or where the diff is not implemented:
 * the script is read, split and analysed, and nothing is executed. The result says what it contains and what is risky,
 * not what it changed.
 */
export function staticSimulation(migrations: Migration[], driver: DriverName): MigrationSimulation[] {
  return migrations.map(m => {
    try {
      const statements = parseScript(m.sql, driver)
      const findings = analyze(statements, driver)
      const results: StatementResult[] = statements.map(s => ({ index: s.index, line: s.line, summary: s.summary, kind: s.kind, ...(s.kind === 'transaction-control' ? { skipped: 'Transaction control: the console handles it.', skippedCode: 'transaction-control' } : {}) }))
      return { version: m.version, name: m.name, outcome: 'ok' as const, durationMs: 0, statements: results, findings, changes: [], noop: false }
    } catch (e) {
      const detail = (e as Error).message
      const error = e instanceof UnsupportedScriptError ? detail : `Cannot read the script: ${detail}`
      const errorInfo = { code: 'script-unreadable', params: { detail } }
      return { version: m.version, name: m.name, outcome: 'failed' as const, error, errorInfo, durationMs: 0, statements: [], findings: [], changes: [], noop: false }
    }
  })
}
