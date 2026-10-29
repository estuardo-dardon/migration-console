export const LANGS: readonly string[]
export const DEFAULT_LANG: string
export function isLang(value: unknown): boolean
export interface Translator {
  (key: string, params?: Record<string, string | number>): string
  parts(key: string, params?: Record<string, unknown>): unknown[]
  has(key: string): boolean
  lang: string
}
export function makeT(catalogs: Record<string, Record<string, string>>, lang?: string): Translator
