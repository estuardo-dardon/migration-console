import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { Engine } from '../src/engine.js'
import { createApp, tokenMatches } from '../src/server.js'
import type { Driver } from '../src/drivers/driver.js'
import type { ConsoleConfig, HistoryRow } from '../src/types.js'

const TOKEN = 'a-long-enough-secret-token'
const dir = mkdtempSync(join(tmpdir(), 'mc-server-'))
writeFileSync(join(dir, '20261001000000_one.sql'), 'create table a (x int);')
writeFileSync(join(dir, '20261002000000_two.sql'), 'create table b (x int);')

const config: ConsoleConfig = {
  migrationsDir: dir, port: 0, host: '127.0.0.1',
  environments: [{ name: 'dev', driver: 'postgres', url: 'postgres://u:SECRET@h/db', mode: 'apply' }, { name: 'prod', driver: 'postgres', url: 'postgres://u:SECRET@h/db', mode: 'simulate-only' }],
}

let history: HistoryRow[] | null = []
const applied: string[] = []
const driver = (): Driver => ({
  name: 'postgres', capabilities: { transactionalDDL: true, catalogDiff: true },
  connect: async () => {}, close: async () => {},
  readHistory: async () => history, initHistory: async () => { history = history ?? [] }, baseline: async () => {},
  simulate: async ms => ms.map(m => ({ version: m.version, name: m.name, outcome: 'ok' as const, durationMs: 1, statements: [], findings: [], changes: [{ kind: 'table', identity: `public.${m.name}`, type: 'added' as const }], noop: false })),
  apply: async m => { applied.push(m.version); return { durationMs: 3, partial: false } },
  blockers: async () => [],
})

let server: Server, base = ''
beforeAll(async () => {
  server = createApp(new Engine(config, driver), config, TOKEN)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>(r => server.close(() => r())))

const call = (path: string, init: { method?: string; body?: unknown; token?: string | null; user?: string } = {}) =>
  fetch(base + path, {
    method: init.method ?? 'GET',
    headers: { ...(init.token === null ? {} : { Authorization: `Bearer ${init.token ?? TOKEN}` }), ...(init.user ? { 'X-Console-User': init.user } : {}), ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })

describe('access', () => {
  it('every /api route needs the token, except /api/health', async () => {
    expect((await call('/api/health', { token: null })).status).toBe(200)
    for (const t of [null, 'wrong', TOKEN + 'x']) {
      expect((await call('/api/environments', { token: t })).status, String(t)).toBe(401)
      expect((await call('/api/environments/dev/migrations', { token: t })).status).toBe(401)
      expect((await call('/api/environments/dev/apply', { method: 'POST', body: {}, token: t, user: 'ana' })).status).toBe(401)
    }
  })

  it('compares tokens without leaking length or content', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true)
    expect(tokenMatches(TOKEN.slice(1), TOKEN)).toBe(false)
    expect(tokenMatches(undefined, TOKEN)).toBe(false)
  })

  it('serves the screen without a token, with a strict content security policy', async () => {
    const res = await call('/', { token: null })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const csp = res.headers.get('content-security-policy')!
    expect(csp).toContain("default-src 'self'")
    expect(csp).not.toContain('unsafe-inline')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect((await call('/app.js', { token: null })).headers.get('content-type')).toContain('javascript')
  })

  it('never sends a connection string', async () => {
    const text = JSON.stringify(await (await call('/api/environments')).json()) + JSON.stringify(await (await call('/api/environments/dev/migrations')).json())
    expect(text).not.toContain('SECRET'); expect(text).not.toContain('postgres://')
  })
})

describe('routes', () => {
  it('lists environments and migrations with their status', async () => {
    expect((await (await call('/api/environments')).json()).environments).toEqual([{ name: 'dev', driver: 'postgres', mode: 'apply' }, { name: 'prod', driver: 'postgres', mode: 'simulate-only' }])
    const s = await (await call('/api/environments/dev/migrations')).json()
    expect(s).toMatchObject({ environment: 'dev', tracked: true })
    expect(s.migrations.map((m: any) => m.status)).toEqual(['pending', 'pending'])
  })

  it('shows the script of a migration', async () => {
    const r = await (await call('/api/environments/dev/migrations/20261001000000/sql')).json()
    expect(r).toMatchObject({ version: '20261001000000', sql: 'create table a (x int);' })
    expect((await call('/api/environments/dev/migrations/999/sql')).status).toBe(404)
  })

  it('unknown environment or path is a 404 with a JSON error', async () => {
    const res = await call('/api/environments/nope/migrations')
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('environment_not_found')
    expect((await call('/api/nothing')).status).toBe(404)
  })

  it('simulates anywhere, and says nothing was committed', async () => {
    const r = await (await call('/api/environments/prod/simulate', { method: 'POST', body: { versions: ['20261001000000'] } })).json()
    expect(r).toMatchObject({ environment: 'prod', committed: false })
    expect(r.migrations[0].changes).toEqual([{ kind: 'table', identity: 'public.one', type: 'added' }])
  })

  it('refuses malformed requests', async () => {
    expect((await call('/api/environments/dev/simulate', { method: 'POST', body: { versions: 'x' } })).status).toBe(400)
    const bad = await fetch(base + '/api/environments/dev/simulate', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{nope' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.code).toBe('invalid_json')
    const big = await fetch(base + '/api/environments/dev/simulate', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ x: 'a'.repeat(70_000) }) })
    expect(big.status).toBe(413)
    expect((await call('/api/environments/dev/simulate')).status).toBe(405)
  })
})

describe('changing things', () => {
  it('needs to know who is doing it', async () => {
    const res = await call('/api/environments/dev/apply', { method: 'POST', body: { version: '20261001000000', confirm: '20261001000000' } })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('user_required')
  })

  it('a simulation-only environment answers 403 to apply, init and baseline', async () => {
    for (const [action, body] of [['apply', { version: '20261001000000', confirm: '20261001000000' }], ['init', {}], ['baseline', { upTo: '20261001000000', confirm: '20261001000000' }]] as const) {
      const res = await call(`/api/environments/prod/${action}`, { method: 'POST', body, user: 'ana' })
      expect(res.status, action).toBe(403)
      expect((await res.json()).error.code).toBe('simulate_only')
    }
    expect(applied).toEqual([])
  })

  it('apply: needs the simulation, then the typed version, then applies', async () => {
    const body = { version: '20261001000000', confirm: '20261001000000' }
    expect((await (await call('/api/environments/dev/apply', { method: 'POST', body, user: 'ana' })).json()).error.code).toBe('simulation_required')
    await call('/api/environments/dev/simulate', { method: 'POST', body: { versions: ['20261001000000'] } })
    expect((await (await call('/api/environments/dev/apply', { method: 'POST', body: { ...body, confirm: 'si' }, user: 'ana' })).json()).error.code).toBe('confirmation_mismatch')
    const ok = await call('/api/environments/dev/apply', { method: 'POST', body, user: 'ana' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ version: '20261001000000', durationMs: 3, partial: false })
    expect(applied).toEqual(['20261001000000'])
  })
})
