// Pure translation helpers shared by the browser and the server (the CLI). The catalogs are `locales/<lang>.json`:
// flat keys, `{name}` placeholders, and `key_one` / `key_other` variants chosen by the `count` parameter.
export const LANGS = ['es-ES', 'en-US']
export const DEFAULT_LANG = 'es-ES'
export const isLang = value => LANGS.includes(value)

export function makeT(catalogs, lang) {
  const active = isLang(lang) ? lang : DEFAULT_LANG
  const plural = new Intl.PluralRules(active)
  const template = (key, params) => {
    for (const code of [active, DEFAULT_LANG]) {
      const catalog = catalogs[code] || {}
      if (params && typeof params.count === 'number') {
        const hit = catalog[`${key}_${plural.select(params.count)}`] ?? catalog[`${key}_other`]
        if (hit !== undefined) return hit
      }
      if (catalog[key] !== undefined) return catalog[key]
    }
    return key
  }
  /** Text with `{name}` filled in. */
  const t = (key, params = {}) => template(key, params).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m))
  /** The pieces of the text, with a parameter's value (a DOM node, say) in place of its `{name}`: nothing is parsed as HTML. */
  t.parts = (key, params = {}) => template(key, params).split(/(\{\w+\})/).map(p => { const m = /^\{(\w+)\}$/.exec(p); return m && m[1] in params ? params[m[1]] : p }).filter(p => p !== '')
  t.has = key => (catalogs[active] || {})[key] !== undefined
  t.lang = active
  return t
}
