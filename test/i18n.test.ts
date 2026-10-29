import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_LANG, LANGS, loadCatalogs, pickLang, translator } from '../src/i18n.js'
import { RULES, analyze, parseScript } from '../src/sql/analyze.js'

const catalogs = loadCatalogs()
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]!).sort()
const base = (key: string) => key.replace(/_(one|other)$/, '')

describe('catalogs', () => {
  it('es-ES is the default and both languages are the ones in the folder', () => {
    expect(DEFAULT_LANG).toBe('es-ES')
    expect(readdirSync(join(import.meta.dirname, '../src/ui/locales')).map(f => f.replace('.json', '')).sort()).toEqual([...LANGS].sort())
  })

  it('both languages have exactly the same keys', () => {
    const [a, b] = LANGS.map(l => Object.keys(catalogs[l]!).sort())
    expect(a).toEqual(b)
  })

  it('a translation uses the same placeholders as the other language', () => {
    for (const key of Object.keys(catalogs['es-ES']!)) expect(placeholders(catalogs['en-US']![key]!), key).toEqual(placeholders(catalogs['es-ES']![key]!))
  })

  it('no translation is empty, and plural variants come in pairs', () => {
    for (const l of LANGS) for (const [k, v] of Object.entries(catalogs[l]!)) {
      expect(v.trim(), `${l} ${k}`).not.toBe('')
      if (/_(one|other)$/.test(k)) expect([`${base(k)}_one`, `${base(k)}_other`].every(x => x in catalogs[l]!), `${l} ${k}`).toBe(true)
    }
  })

  it('every risk rule has a translated message in each language', () => {
    const codes = [...RULES.map(r => r.code), 'transaction-control', 'non-transactional', 'implicit-commit']
    for (const l of LANGS) for (const c of codes) expect(catalogs[l]![`finding.${c}`], `${l} finding.${c}`).toBeTruthy()
  })

  it('every error code the engine and server raise has a translation', () => {
    const src = ['engine.ts', 'server.ts'].map(f => readFileSync(join(import.meta.dirname, '../src', f), 'utf8')).join('\n')
    const codes = new Set([...src.matchAll(/ConsoleError\(\d+, '(\w+)'/g)].map(m => m[1]!).concat(['unauthorized', 'not_found', 'method_not_allowed', 'internal_error']))
    for (const l of LANGS) for (const c of codes) expect(catalogs[l]![`error.${c}`], `${l} error.${c}`).toBeTruthy()
  })

  it('the page declares only keys that exist', () => {
    const html = readFileSync(join(import.meta.dirname, '../src/ui/index.html'), 'utf8')
    for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) expect(catalogs['es-ES']![m[1]!], m[1]).toBeTruthy()
  })

  it('every key the UI and the CLI ask for exists', () => {
    const src = ['ui/app.js', 'cli.ts'].map(f => readFileSync(join(import.meta.dirname, '../src', f), 'utf8')).join('\n')
    for (const m of src.matchAll(/\bt\(\s*'([\w.-]+)'/g)) expect(Object.keys(catalogs['es-ES']!).some(k => base(k) === m[1]), m[1]).toBe(true)
  })
})

describe('translator', () => {
  it('fills placeholders and picks the plural form', () => {
    const es = translator('es-ES'), en = translator('en-US')
    expect(es('result.rows', { summary: 'INSERT INTO a', count: 1 })).toBe('INSERT INTO a → 1 fila')
    expect(es('result.rows', { summary: 'INSERT INTO a', count: 3 })).toBe('INSERT INTO a → 3 filas')
    expect(en('result.rows', { summary: 'INSERT INTO a', count: 1 })).toBe('INSERT INTO a → 1 row')
    expect(en('toast.applied', { version: '1', ms: 5 })).toBe('Applied 1 in 5 ms')
  })

  it('falls back to the default language, then to the key', () => {
    expect(translator('fr-FR')('status.pending')).toBe('Pendiente')
    expect(translator('en-US')('no.such.key')).toBe('no.such.key')
  })

  it('parts() puts a value in place of its placeholder without parsing anything as markup', () => {
    expect(translator('en-US').parts('dialog.type', { text: '<b>x</b>' })).toEqual(['Type ', '<b>x</b>', ' to confirm:'])
  })

  it('translates the findings the analyzer produces', () => {
    const f = analyze(parseScript('delete from a;', 'postgres'), 'postgres')[0]!
    expect(translator('es-ES')(`finding.${f.code}`)).toMatch(/DELETE sin WHERE/)
    expect(translator('en-US')(`finding.${f.code}`)).toMatch(/DELETE without WHERE/)
  })
})

describe('pickLang', () => {
  it('prefers the flag, then CONSOLE_LANG, then the system language, then es-ES', () => {
    expect(pickLang('en-US', { CONSOLE_LANG: 'es-ES' })).toBe('en-US')
    expect(pickLang(undefined, { CONSOLE_LANG: 'en-us', LANG: 'es_ES.UTF-8' })).toBe('en-US')
    expect(pickLang(undefined, { LANG: 'en_GB.UTF-8' })).toBe('en-US')
    expect(pickLang(undefined, { LANG: 'es_MX.UTF-8' })).toBe('es-ES')
    expect(pickLang(undefined, { LANG: 'C.UTF-8' })).toBe('es-ES')
    expect(pickLang('xx', {})).toBe('es-ES')
  })
})
