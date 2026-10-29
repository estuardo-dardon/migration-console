import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LANG, LANGS, isLang, makeT, type Translator } from './ui/i18n.js'

export { DEFAULT_LANG, LANGS, isLang }
export type { Translator }

const DIR = fileURLToPath(new URL('./ui/locales/', import.meta.url))
export const loadCatalogs = (): Record<string, Record<string, string>> => Object.fromEntries(LANGS.map(l => [l, JSON.parse(readFileSync(join(DIR, `${l}.json`), 'utf8')) as Record<string, string>]))

/** The language of the terminal: `--lang`, then `CONSOLE_LANG`, then the system locale (`es_ES.UTF-8` → `es-ES`), else the default. */
export function pickLang(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const system = (env.LC_ALL || env.LC_MESSAGES || env.LANG || '').split('.')[0]!.replace('_', '-')
  for (const candidate of [flag, env.CONSOLE_LANG, system]) {
    if (!candidate) continue
    const exact = LANGS.find(l => l.toLowerCase() === candidate.toLowerCase())
    const byLanguage = LANGS.find(l => l.split('-')[0] === candidate.split('-')[0]!.toLowerCase())
    if (exact || byLanguage) return (exact ?? byLanguage)!
  }
  return DEFAULT_LANG
}

export const translator = (lang: string): Translator => makeT(loadCatalogs(), lang)
