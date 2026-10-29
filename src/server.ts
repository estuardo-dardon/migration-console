import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConsoleError, type Engine } from './engine.js'
import { readMigrations } from './source.js'
import type { ConsoleConfig } from './types.js'

const MAX_BODY = 64 * 1024
const UI_DIR = fileURLToPath(new URL('./ui/', import.meta.url))
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' }
const STATIC = new Set(['/', '/index.html', '/app.js', '/net.js', '/i18n.js', '/style.css', '/locales/es-ES.json', '/locales/en-US.json'])

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new ConsoleError(413, 'body_too_large', 'The request is too large.')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error()
    return v as Record<string, unknown>
  } catch { throw new ConsoleError(400, 'invalid_json', 'The body must be a JSON object.') }
}

export const tokenMatches = (given: string | undefined, expected: string): boolean => {
  if (!given) return false
  const a = Buffer.from(given), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const str = (v: unknown, field: string, max = 200): string => {
  if (typeof v !== 'string' || !v || v.length > max) throw new ConsoleError(400, 'invalid_request', `${field} is required.`, { field })
  return v
}

/**
 * The HTTP interface. Every /api route except /api/health needs the shared token. The user who confirms an action is
 * a name typed in the screen (`X-Console-User`): it labels the history, it is not a login. Operations on one
 * environment run one at a time.
 */
export function createApp(engine: Engine, config: ConsoleConfig, token: string): Server {
  const busy = new Set<string>()

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (method === 'GET' && STATIC.has(path)) {
      const file = path === '/' ? 'index.html' : path.slice(1)
      return send(res, 200, readFileSync(join(UI_DIR, file), 'utf8'), TYPES[extname(file)] ?? 'text/plain')
    }
    if (method === 'GET' && path === '/api/health') return send(res, 200, { ok: true })
    if (!path.startsWith('/api/')) return send(res, 404, { error: { code: 'not_found', message: 'Not found.' } })

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (!tokenMatches(bearer, token)) return send(res, 401, { error: { code: 'unauthorized', message: 'Missing or wrong token.' } })
    const user = String(req.headers['x-console-user'] ?? '').trim().slice(0, 80)

    if (method === 'GET' && path === '/api/environments') return send(res, 200, { environments: engine.environments() })

    const m = /^\/api\/environments\/([^/]+)\/(migrations|simulate|apply|init|baseline)(?:\/([^/]+)\/sql)?$/.exec(path)
    if (!m) return send(res, 404, { error: { code: 'not_found', message: 'Not found.' } })
    const env = decodeURIComponent(m[1]!)
    const action = m[2]!

    if (method === 'GET' && action === 'migrations' && m[3]) {
      engine.environments().find(e => e.name === env) ?? (() => { throw new ConsoleError(404, 'environment_not_found', 'No such environment.') })()
      const file = readMigrations(config.migrationsDir).find(x => x.version === m[3])
      if (!file) throw new ConsoleError(404, 'migration_not_found', 'No such migration.')
      return send(res, 200, { version: file.version, name: file.name, file: file.file, checksum: file.checksum, sql: file.sql })
    }
    if (method === 'GET' && action === 'migrations') return send(res, 200, await engine.status(env))
    if (method !== 'POST') return send(res, 405, { error: { code: 'method_not_allowed', message: 'Use POST.' } })

    const body = await readJson(req)
    if (busy.has(env)) throw new ConsoleError(409, 'busy', `Another operation is running on ${env}. Wait for it to finish.`, { environment: env })
    busy.add(env)
    try {
      if (action === 'simulate') {
        const versions = body.versions === undefined ? undefined : Array.isArray(body.versions) && body.versions.every(v => typeof v === 'string') ? (body.versions as string[]) : (() => { throw new ConsoleError(400, 'invalid_request', 'versions must be a list of strings.') })()
        return send(res, 200, await engine.simulate(env, { versions }))
      }
      if (!user) throw new ConsoleError(400, 'user_required', 'Say who you are (X-Console-User) before changing anything.')
      if (action === 'apply') return send(res, 200, await engine.apply(env, { version: str(body.version, 'version', 40), confirm: str(body.confirm, 'confirm', 40), user }))
      if (action === 'init') { await engine.init(env); return send(res, 200, { ok: true }) }
      if (action === 'baseline') return send(res, 200, await engine.baseline(env, { upTo: str(body.upTo, 'upTo', 40), confirm: str(body.confirm, 'confirm', 40), user }))
      return send(res, 404, { error: { code: 'not_found', message: 'Not found.' } })
    } finally {
      busy.delete(env)
    }
  }

  return createServer((req, res) => {
    route(req, res).catch(err => {
      if (err instanceof ConsoleError) return send(res, err.status, { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } })
      console.error('[migration-console] unexpected error:', err instanceof Error ? err.message : err)
      send(res, 500, { error: { code: 'internal_error', message: 'Unexpected error.' } })
    })
  })
}
