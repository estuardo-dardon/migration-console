import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Migration } from './types.js'

const FILE = /^(\d{8,20})[_-](.+)\.sql$/i

/**
 * The migrations in a directory: `<digits>_<name>.sql` (the format of Supabase, Flyway-style timestamps and most tools).
 * Ordered by version as TEXT, so a fixed-width timestamp sorts chronologically. Anything else in the folder is ignored.
 */
export function readMigrations(dir: string): Migration[] {
  const out: Migration[] = []
  for (const file of readdirSync(dir)) {
    const m = FILE.exec(file)
    if (!m || !statSync(join(dir, file)).isFile()) continue
    const sql = readFileSync(join(dir, file), 'utf8')
    out.push({ version: m[1]!, name: m[2]!, file, sql, checksum: createHash('sha256').update(sql).digest('hex') })
  }
  const versions = new Set<string>()
  for (const m of out) {
    if (versions.has(m.version)) throw new Error(`Two migrations share the version ${m.version}`)
    versions.add(m.version)
  }
  return out.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0))
}
