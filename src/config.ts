import { readFileSync } from 'node:fs'
import type { ConsoleConfig, DriverName, EnvironmentConfig, EnvMode } from './types.js'

const DRIVERS: DriverName[] = ['postgres', 'mysql', 'mssql']
const MODES: EnvMode[] = ['apply', 'simulate-only']

/** `${NAME}` becomes the value of that environment variable; a missing one is an error, never an empty string. */
export function interpolate(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = env[name]
    if (v === undefined || v === '') throw new Error(`The environment variable ${name} is not set (used in the configuration)`)
    return v
  })
}

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): ConsoleConfig {
  if (!raw || typeof raw !== 'object') throw new Error('The configuration must be a JSON object')
  const c = raw as Record<string, unknown>
  if (typeof c.migrationsDir !== 'string' || !c.migrationsDir) throw new Error('migrationsDir is required')
  if (!Array.isArray(c.environments) || c.environments.length === 0) throw new Error('environments must list at least one environment')
  const names = new Set<string>()
  const environments: EnvironmentConfig[] = c.environments.map((e: any, i: number) => {
    const where = `environments[${i}]`
    if (!e || typeof e.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(e.name)) throw new Error(`${where}.name must be 1–32 letters, digits, - or _`)
    if (names.has(e.name)) throw new Error(`${where}.name "${e.name}" is repeated`)
    names.add(e.name)
    if (!DRIVERS.includes(e.driver)) throw new Error(`${where}.driver must be one of ${DRIVERS.join(', ')}`)
    if (typeof e.url !== 'string' || !e.url) throw new Error(`${where}.url is required`)
    // `mode` has no default: whether an environment can be changed must be a conscious choice.
    if (!MODES.includes(e.mode)) throw new Error(`${where}.mode must be one of ${MODES.join(', ')}`)
    const schemas = e.schemas === undefined ? undefined : Array.isArray(e.schemas) && e.schemas.every((s: unknown) => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) ? (e.schemas as string[]) : (() => { throw new Error(`${where}.schemas must be a list of schema names`) })()
    const ms = (v: unknown, name: string) => (v === undefined ? undefined : typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3_600_000 ? v : (() => { throw new Error(`${where}.${name} must be a whole number of milliseconds (0 to 3600000)`) })())
    return { name: e.name, driver: e.driver, url: interpolate(e.url, env), mode: e.mode, schemas, lockTimeoutMs: ms(e.lockTimeoutMs, 'lockTimeoutMs'), statementTimeoutMs: ms(e.statementTimeoutMs, 'statementTimeoutMs') }
  })
  const port = c.port === undefined ? 8080 : c.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be between 1 and 65535')
  return { migrationsDir: c.migrationsDir, port, host: typeof c.host === 'string' ? c.host : '127.0.0.1', environments }
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): ConsoleConfig {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch (e) { throw new Error(`Cannot read the configuration ${path}: ${(e as Error).message}`) }
  let json: unknown
  try { json = JSON.parse(text) } catch { throw new Error(`The configuration ${path} is not valid JSON`) }
  return parseConfig(json, env)
}

/** The same URL with the password hidden, for logs and screens. */
export function redactUrl(url: string): string {
  return url.replace(/(:\/\/[^:/@\s]+:)[^@/\s]*@/, '$1***@')
}
