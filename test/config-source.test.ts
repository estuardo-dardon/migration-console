import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interpolate, parseConfig, redactUrl } from '../src/config.js'
import { readMigrations } from '../src/source.js'

const env = (e: Record<string, unknown>[] = [{ name: 'dev', driver: 'postgres', url: 'postgres://u:p@h/db', mode: 'apply' }]) => ({ migrationsDir: '/m', environments: e })

describe('config', () => {
  it('replaces ${VAR} from the environment and refuses a missing one', () => {
    expect(interpolate('postgres://u:${PW}@h/${DB}', { PW: 'secret', DB: 'x' })).toBe('postgres://u:secret@h/x')
    expect(() => interpolate('${NOPE}', {})).toThrow(/NOPE/)
    expect(() => interpolate('${EMPTY}', { EMPTY: '' })).toThrow(/EMPTY/)
  })

  it('reads a valid configuration with safe defaults (loopback host, port 8080)', () => {
    const c = parseConfig(env(), {})
    expect(c).toMatchObject({ migrationsDir: '/m', port: 8080, host: '127.0.0.1', environments: [{ name: 'dev', driver: 'postgres', mode: 'apply' }] })
  })

  it('every environment must say whether it can be changed — there is no default', () => {
    expect(() => parseConfig(env([{ name: 'prod', driver: 'postgres', url: 'x' }]), {})).toThrow(/mode/)
    expect(() => parseConfig(env([{ name: 'prod', driver: 'postgres', url: 'x', mode: 'yes' }]), {})).toThrow(/mode/)
  })

  it.each([
    [{ ...env(), environments: [] }, /environments/],
    [env([{ name: 'a b', driver: 'postgres', url: 'x', mode: 'apply' }]), /name/],
    [env([{ name: 'a', driver: 'oracle', url: 'x', mode: 'apply' }]), /driver/],
    [env([{ name: 'a', driver: 'postgres', url: '', mode: 'apply' }]), /url/],
    [env([{ name: 'a', driver: 'postgres', url: 'x', mode: 'apply' }, { name: 'a', driver: 'mysql', url: 'y', mode: 'apply' }]), /repeated/],
    [env([{ name: 'a', driver: 'postgres', url: 'x', mode: 'apply', schemas: ['ok', 'bad;drop'] }]), /schemas/],
    [env([{ name: 'a', driver: 'postgres', url: 'x', mode: 'apply', lockTimeoutMs: -1 }]), /lockTimeoutMs/],
    [{ ...env(), port: 70000 }, /port/],
    [{ environments: env().environments }, /migrationsDir/],
    [null, /JSON object/],
  ])('refuses %j', (raw, message) => { expect(() => parseConfig(raw, {})).toThrow(message) })

  it('hides the password of a URL', () => {
    expect(redactUrl('postgres://user:s3cret@host:5432/db')).toBe('postgres://user:***@host:5432/db')
    expect(redactUrl('no url here')).toBe('no url here')
  })
})

describe('readMigrations', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'mc-'))

  it('reads <version>_<name>.sql files in version order and ignores everything else', () => {
    const d = dir()
    writeFileSync(join(d, '20261108000000_b.sql'), 'select 2;')
    writeFileSync(join(d, '20261029000000_a_first.sql'), 'select 1;')
    writeFileSync(join(d, 'README.md'), 'x'); writeFileSync(join(d, 'notes.sql'), 'x'); mkdirSync(join(d, '20261109000000_dir.sql'))
    const m = readMigrations(d)
    expect(m.map(x => `${x.version}:${x.name}`)).toEqual(['20261029000000:a_first', '20261108000000:b'])
    expect(m[0]!.checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the checksum changes with the content', () => {
    const d = dir()
    writeFileSync(join(d, '20261029000000_a.sql'), 'select 1;')
    const before = readMigrations(d)[0]!.checksum
    writeFileSync(join(d, '20261029000000_a.sql'), 'select 1; ')
    expect(readMigrations(d)[0]!.checksum).not.toBe(before)
  })

  it('refuses two files with one version', () => {
    const d = dir()
    writeFileSync(join(d, '20261029000000_a.sql'), 'x'); writeFileSync(join(d, '20261029000000_b.sql'), 'y')
    expect(() => readMigrations(d)).toThrow(/share the version/)
  })
})
