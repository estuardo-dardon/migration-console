import { netChanges } from '/net.js'
import { DEFAULT_LANG, LANGS, isLang, makeT } from '/i18n.js'
// Plain ES module, no build step. Everything shown is inserted as text (never as HTML).
const $ = id => document.getElementById(id)
const LANG_KEY = 'mc.lang'
const storedLang = () => { try { return localStorage.getItem(LANG_KEY) } catch { return null } }
const catalogs = Object.fromEntries(await Promise.all(LANGS.map(async l => [l, await fetch(`/locales/${l}.json`).then(r => r.json())])))
let t = makeT(catalogs, isLang(storedLang()) ? storedLang() : DEFAULT_LANG)
const state = { token: sessionStorage.getItem('mc.token') || '', envs: [], env: null, status: null, selected: new Set(), result: null }

function h(tag, props, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v == null) continue
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = !!v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)))
  return el
}
const clear = el => { while (el.firstChild) el.removeChild(el.firstChild) }

const CHANGE = { added: '+', changed: '~', removed: '−' }

// The server sends codes (and English fallbacks); every text the person reads comes from the catalog of the chosen language.
const statusLabel = s => t(`status.${s}`)
const levelLabel = l => t(`level.${l}`)
const kindLabel = k => t.has(`kind.${k}`) ? t(`kind.${k}`) : k
/** A translated `{ code, params }` (or the plain English text when the catalog does not know the code). */
const say = (prefix, info, fallback) => info && t.has(`${prefix}.${info.code}`) ? t(`${prefix}.${info.code}`, info.params) : fallback
const findingText = f => t.has(`finding.${f.code}`) ? t(`finding.${f.code}`) : f.message
const errorText = e => t.has(`error.${e.code}`) ? t(`error.${e.code}`, e.details) : (e.fallback || t('error.unknown'))
const when = iso => new Date(iso).toLocaleString(t.lang)

function applyStatic() {
  document.documentElement.lang = t.lang.split('-')[0]
  document.title = t('app.title')
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n)
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder))
  for (const el of document.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel))
  $('lang').value = t.lang
}

function setLang(lang) {
  t = makeT(catalogs, lang)
  try { localStorage.setItem(LANG_KEY, t.lang) } catch { /* storage can be blocked: the choice then lasts until the page closes */ }
  applyStatic()
  if (!$('app').hidden) { renderTabs(); renderInfo(); renderToolbar(); renderTable(); if (state.result) renderResult() }
}

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true }, 4000)
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: { Authorization: 'Bearer ' + state.token, 'X-Console-User': $('user').value.trim(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401) { logout(); throw Object.assign(new Error(t('error.unauthorized')), { code: 'unauthorized' }) }
  if (!res.ok) throw new ApiError(data.error)
  return data
}

/** The message is rendered when it is shown, in the language chosen at that moment. */
class ApiError extends Error {
  constructor(error = {}) { super(error.message || 'Unexpected error.'); this.code = error.code; this.details = error.details; this.fallback = error.message }
  get text() { return errorText(this) }
}
const failure = e => e instanceof ApiError ? e.text : e.code === 'unauthorized' ? e.message : t('error.network')

function logout() {
  sessionStorage.removeItem('mc.token'); state.token = ''
  $('app').hidden = true; $('who').hidden = true; $('login').hidden = false
}

async function start() {
  try {
    state.envs = (await api('/environments')).environments
  } catch (e) { $('login-error').textContent = failure(e); $('login-error').hidden = false; return }
  $('login').hidden = true; $('app').hidden = false; $('who').hidden = false
  $('user').value = localStorage.getItem('mc.user') || ''
  renderTabs()
  await selectEnv(state.envs[0]?.name)
}

function renderTabs() {
  const nav = $('envs'); clear(nav)
  for (const e of state.envs) {
    nav.append(h('button', { class: 'tab', role: 'tab', 'aria-selected': String(e.name === state.env), onclick: () => selectEnv(e.name) },
      e.name, ' ', h('span', { class: 'mode' + (e.mode === 'simulate-only' ? ' readonly' : '') }, t(`mode.${e.mode}`))))
  }
}

async function selectEnv(name) {
  if (!name) return
  state.env = name; state.selected = new Set(); state.result = null; $('result').hidden = true
  renderTabs()
  await refresh()
}

async function refresh() {
  try {
    state.status = await api(`/environments/${encodeURIComponent(state.env)}/migrations`)
  } catch (e) { toast(failure(e)); state.status = null }
  renderInfo(); renderToolbar(); renderTable()
}

function renderInfo() {
  const el = $('env-info'); clear(el)
  const s = state.status
  if (!s) { el.append(h('p', { class: 'error', role: 'alert' }, t('env.unreadable'))); return }
  el.append(h('h2', null, s.environment, ' ', h('span', { class: 'mode' }, s.driver)))
  if (s.mode === 'simulate-only') el.append(h('div', { class: 'banner warn' }, t('env.readonly')))
  if (!s.tracked) el.append(h('div', { class: 'banner' }, t(`env.untracked.${s.mode === 'apply' ? 'apply' : 'simulate'}`)))
  el.append(h('p', { class: 'muted' }, t(`env.sim.${s.simulation}`)))
}

function fromSelect() {
  const s = state.status
  const sel = h('select', { id: 'from-version', 'aria-label': t('toolbar.fromAria') }, h('option', { value: '' }, t('toolbar.fromPlaceholder')),
    ...s.migrations.map(m => h('option', { value: m.version }, `${m.version}_${m.name}`)))
  return sel
}

function renderToolbar() {
  const bar = $('toolbar'); clear(bar)
  const s = state.status
  if (!s) return
  const pending = s.migrations.filter(m => ['pending', 'failed', 'modified'].includes(m.status))
  if (s.tracked) bar.append(h('button', { class: 'primary', disabled: pending.length === 0, onclick: () => simulate(pending.map(m => m.version)) }, t('toolbar.simulatePending', { count: pending.length })))
  bar.append(h('button', { disabled: state.selected.size === 0, onclick: () => simulate([...state.selected]) }, t('toolbar.simulateSelected', { count: state.selected.size })))
  const from = fromSelect()
  bar.append(from, h('button', { onclick: () => {
    if (!from.value) return toast(t('toast.pickFrom'))
    simulate(s.migrations.filter(m => m.version >= from.value && m.status !== 'completed').map(m => m.version))
  } }, t('toolbar.simulateFrom')))
  if (s.mode === 'apply' && !s.tracked) bar.append(h('button', { onclick: init }, t('toolbar.init')))
  if (s.mode === 'apply') bar.append(h('button', { onclick: () => baseline(from.value) }, t('toolbar.baseline')))
  bar.append(h('button', { class: 'link', onclick: refresh }, t('toolbar.refresh')))
}

function renderTable() {
  const body = document.querySelector('#migrations tbody'); clear(body)
  const s = state.status
  $('empty').hidden = !s || s.migrations.length > 0
  if (!s) return
  for (const m of [...s.migrations].reverse()) {
    const check = h('input', { type: 'checkbox', 'aria-label': t('row.select', { version: m.version }), checked: state.selected.has(m.version), disabled: m.status === 'completed',
      onchange: ev => { ev.target.checked ? state.selected.add(m.version) : state.selected.delete(m.version); renderToolbar() } })
    body.append(h('tr', null,
      h('td', null, check),
      h('td', { class: 'mono' }, m.version),
      h('td', null, m.name, m.baselined ? h('span', { class: 'muted' }, t('row.baselined')) : null, m.error ? h('div', { class: 'error' }, m.error) : null),
      h('td', null, h('span', { class: `badge s-${m.status}` }, statusLabel(m.status))),
      h('td', { class: 'muted' }, m.appliedAt ? `${when(m.appliedAt)}${m.appliedBy ? ' · ' + m.appliedBy : ''}` : ''),
      h('td', null, h('button', { class: 'link', onclick: () => viewScript(m) }, t('row.viewScript')))))
  }
}

async function viewScript(m) {
  try {
    const f = await api(`/environments/${encodeURIComponent(state.env)}/migrations/${m.version}/sql`)
    dialog(`${f.file}`, h('div', null, h('p', { class: 'muted mono' }, t('script.sha', { checksum: f.checksum })), h('pre', { class: 'sql' }, f.sql)), { okLabel: t('dialog.close'), hideCancel: true })
  } catch (e) { toast(failure(e)) }
}

async function simulate(versions) {
  if (!versions.length) return toast(t('toast.nothingToSimulate'))
  const out = $('result'); out.hidden = false; clear(out); out.append(h('p', { class: 'muted' }, t('result.simulating')))
  try {
    state.result = await api(`/environments/${encodeURIComponent(state.env)}/simulate`, { method: 'POST', body: { versions } })
    renderResult()
  } catch (e) { clear(out); out.append(h('p', { class: 'error', role: 'alert' }, failure(e))) }
}

function changeRow(c) {
  return h('div', { class: 'change' }, h('span', { class: c.type }, CHANGE[c.type]), h('span', { class: 'muted' }, kindLabel(c.kind)), h('span', { class: 'mono' }, c.identity),
    c.type === 'changed' ? h('small', { class: 'mono' }, `${t('result.before', { value: c.before })}\n${t('result.after', { value: c.after })}`) : c.after ? h('small', { class: 'mono' }, c.after) : null)
}

function renderResult() {
  const out = $('result'); clear(out)
  const r = state.result
  const failed = r.migrations.filter(m => m.outcome === 'failed')
  const todo = r.migrations.filter(m => m.outcome === 'ok' && !m.noop)
  out.append(h('h2', null, t('result.title', { environment: r.environment })),
    h('p', { class: 'muted' }, t.parts('result.meta', { date: when(r.startedAt), ms: r.durationMs, saved: h('strong', null, t('result.nothingSaved')) })))
  for (const b of r.blockers) out.append(h('div', { class: 'banner danger' }, t('result.blocker', { pid: b.pid, detail: `${b.state || '—'}${b.application ? ', ' + b.application : ''}`, seconds: b.openForSeconds ?? '?', query: b.query })))
  for (const n of r.notes) out.append(h('p', { class: 'muted' }, '· ' + say('note', n, n.code)))

  if (r.mode === 'transactional-diff') {
    const all = netChanges(todo)
    out.append(h('h3', null, t('result.toApply')))
    if (failed.length) out.append(h('div', { class: 'banner danger' }, t('result.failedChain', { count: failed.length })))
    if (all.length === 0 && todo.length === 0 && !failed.length) out.append(h('div', { class: 'banner' }, t('result.nothing')))
    else for (const c of all) out.append(h('div', null, changeRow(c)))
    const rows = todo.flatMap(m => m.statements.filter(s => s.rowCount).map(s => t('result.rowsIn', { version: m.version, summary: s.summary, count: s.rowCount })))
    if (rows.length) out.append(h('h3', null, t('result.data')), ...rows.map(t => h('div', { class: 'mono' }, t)))
  }

  out.append(h('div', { class: 'toolbar' }, h('button', { onclick: downloadPlan }, t('result.download'))))

  const canApply = state.status?.mode === 'apply'
  const firstTodo = state.status?.migrations.find(m => m.status !== 'completed')?.version
  for (const m of r.migrations) {
    const card = h('div', { class: 'mig ' + (m.outcome === 'failed' ? 'failed' : m.noop ? 'noop' : '') })
    const head = h('div', { class: 'toolbar' }, h('strong', { class: 'mono' }, `${m.version}_${m.name}`),
      m.outcome === 'failed' ? h('span', { class: 'badge s-failed' }, t('badge.failed')) : m.outcome === 'skipped' ? h('span', { class: 'badge s-unverified' }, t('badge.skipped')) : m.noop ? h('span', { class: 'badge s-completed' }, t('badge.noop')) : h('span', { class: 'badge s-pending' }, t('badge.changes')),
      canApply && m.outcome === 'ok' && m.version === firstTodo ? h('button', { class: 'danger', onclick: () => confirmApply(m) }, t('action.apply')) : null)
    card.append(head)
    if (m.error) card.append(h('p', { class: 'error', role: 'alert' }, say('sim', m.errorInfo, m.error)))
    if (m.skippedReason) card.append(h('p', { class: 'muted' }, say('sim', m.skippedInfo, m.skippedReason)))
    for (const f of m.findings.filter(x => x.level !== 'info' || m.findings.length < 6)) card.append(h('div', { class: 'finding ' + f.level }, t('finding.line', { level: levelLabel(f.level), line: f.line, message: findingText(f) })))
    if (m.changes.length) card.append(h('h3', null, t('result.changes')), ...m.changes.map(changeRow))
    const sk = m.statements.filter(s => s.skipped && s.kind !== 'transaction-control')
    for (const s of sk) card.append(h('div', { class: 'finding warning' }, t('stmt.line', { line: s.line, summary: s.summary, reason: s.skippedCode && t.has(`stmt.${s.skippedCode}`) ? t(`stmt.${s.skippedCode}`) : s.skipped })))
    const dml = m.statements.filter(s => s.rowCount != null)
    if (dml.length) card.append(h('h3', null, t('result.data')), ...dml.map(s => h('div', { class: 'mono' }, t('result.rows', { summary: s.summary, count: s.rowCount }))))
    out.append(card)
  }
  out.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function downloadPlan() {
  const blob = new Blob([JSON.stringify(state.result, null, 2)], { type: 'application/json' })
  const a = h('a', { href: URL.createObjectURL(blob), download: `plan-${state.result.environment}-${Date.now()}.json` })
  document.body.append(a); a.click(); a.remove()
}

function dialog(title, content, { okLabel = t('dialog.confirm'), hideCancel = false, needsText = null, danger = false } = {}) {
  return new Promise(resolve => {
    $('dialog-title').textContent = title
    const body = $('dialog-body'); clear(body); body.append(content)
    const ok = $('dialog-ok'), cancel = $('dialog-cancel')
    ok.textContent = okLabel; ok.className = danger ? 'danger' : 'primary'; cancel.hidden = hideCancel
    ok.disabled = needsText !== null
    const field = needsText !== null ? h('input', { 'aria-label': t('dialog.confirmAria'), autocomplete: 'off', oninput: ev => { ok.disabled = ev.target.value.trim() !== needsText } }) : null
    if (field) body.append(h('p', null, t.parts('dialog.type', { text: h('code', null, needsText) })), field)
    const close = value => { $('dialog').hidden = true; ok.onclick = null; cancel.onclick = null; resolve(value) }
    ok.onclick = () => close(field ? field.value.trim() : true)
    cancel.onclick = () => close(null)
    $('dialog').hidden = false
    field?.focus()
  })
}

async function confirmApply(m) {
  const risky = m.findings.filter(f => f.level !== 'info')
  const content = h('div', null,
    h('p', null, t.parts('apply.intro', { environment: h('strong', null, state.env) })),
    h('p', { class: 'mono' }, `${m.version}_${m.name}`),
    h('p', null, t('apply.changes', { count: m.changes.length })),
    ...risky.map(f => h('div', { class: 'finding ' + f.level }, t('finding.short', { level: levelLabel(f.level), message: findingText(f) }))),
    state.result.blockers.length ? h('div', { class: 'banner danger' }, t('apply.blockers')) : null)
  const typed = await dialog(t('apply.title', { version: m.version }), content, { okLabel: t('apply.ok'), needsText: m.version, danger: true })
  if (typed === null) return
  if (!$('user').value.trim()) return toast(t('toast.needUser'))
  try {
    const r = await api(`/environments/${encodeURIComponent(state.env)}/apply`, { method: 'POST', body: { version: m.version, confirm: typed } })
    toast(t(r.partial ? 'toast.appliedPartial' : 'toast.applied', { version: r.version, ms: r.durationMs }))
    state.result = null; $('result').hidden = true
  } catch (e) { toast(failure(e)) }
  await refresh()
}

async function init() {
  try { await api(`/environments/${encodeURIComponent(state.env)}/init`, { method: 'POST', body: {} }); toast(t('toast.initialized')) } catch (e) { toast(failure(e)) }
  await refresh()
}

async function baseline(upTo) {
  if (!upTo) return toast(t('toast.pickBaseline'))
  const typed = await dialog(t('baseline.title'), h('p', null, t('baseline.body', { version: upTo })), { okLabel: t('baseline.ok'), needsText: upTo, danger: true })
  if (typed === null) return
  try { const r = await api(`/environments/${encodeURIComponent(state.env)}/baseline`, { method: 'POST', body: { upTo, confirm: typed } }); toast(t('toast.baselined', { count: r.marked })) } catch (e) { toast(failure(e)) }
  await refresh()
}

$('login-form').addEventListener('submit', ev => { ev.preventDefault(); state.token = $('token').value.trim(); sessionStorage.setItem('mc.token', state.token); $('login-error').hidden = true; start() })
$('logout').addEventListener('click', logout)
$('lang').addEventListener('change', ev => setLang(ev.target.value))
$('user').addEventListener('input', () => localStorage.setItem('mc.user', $('user').value.trim()))
applyStatic()
if (state.token) start()
