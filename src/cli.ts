#!/usr/bin/env node
import { loadConfig, redactUrl } from './config.js'
import { Engine, ConsoleError } from './engine.js'
import { createApp } from './server.js'
import { pickLang, translator, type Translator } from './i18n.js'
import type { MigrationSimulation, Note, SimulationResult } from './types.js'

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const ICON = { added: '+', changed: '~', removed: '-' } as const

/** A coded message in the language of the terminal; the English text the server sent when the catalog lacks the code. */
const say = (t: Translator, prefix: string, info: Note | undefined, fallback: string) => (info && t.has(`${prefix}.${info.code}`) ? t(`${prefix}.${info.code}`, info.params) : fallback)

function printSimulation(t: Translator, r: SimulationResult) {
  console.log(t('cli.simulation', { environment: r.environment, how: t(`cli.how.${r.mode}`) }))
  for (const b of r.blockers) console.log(t('cli.blocker', { pid: b.pid, seconds: b.openForSeconds ?? '?', state: b.state ?? '—', query: b.query }))
  for (const m of r.migrations) printMigration(t, m)
  for (const n of r.notes) console.log(`\n· ${say(t, 'note', n, n.code)}`)
}

function printMigration(t: Translator, m: MigrationSimulation) {
  const label = t(`cli.label.${m.outcome === 'ok' ? (m.noop ? 'noop' : 'ok') : m.outcome}`)
  console.log(`\n${m.version}_${m.name}: ${label}`)
  if (m.error) console.log(`  ✗ ${say(t, 'sim', m.errorInfo, m.error)}`)
  if (m.skippedReason) console.log(`  ${say(t, 'sim', m.skippedInfo, m.skippedReason)}`)
  for (const f of m.findings.filter(x => x.level !== 'info')) console.log(t('cli.finding', { mark: f.level === 'danger' ? '‼' : '!', line: f.line, message: t.has(`finding.${f.code}`) ? t(`finding.${f.code}`) : f.message }))
  for (const s of m.statements) if (s.rowCount) console.log(t('cli.rows', { summary: s.summary, count: s.rowCount }))
  for (const c of m.changes) console.log(`  ${ICON[c.type]} ${c.kind} ${c.identity}${c.after && c.type !== 'changed' ? `  (${c.after})` : ''}`)
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  const t = translator(pickLang(arg(args, '--lang')))
  if (!command || command === '--help' || command === '-h' || command === 'help') return console.log(t('cli.help'))
  const configPath = arg(args, '--config') ?? process.env.CONSOLE_CONFIG ?? 'config.json'
  const config = loadConfig(configPath)
  const engine = new Engine(config)
  const json = args.includes('--json')
  const positional = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1]!.startsWith('--') && a !== undefined && ['--config', '--confirm', '--user', '--lang'].includes(all[i - 1]!)))

  if (command === 'check') {
    for (const e of config.environments) console.log(`${e.name}\t${e.driver}\t${e.mode}\t${redactUrl(e.url)}`)
    return
  }
  if (command === 'serve') {
    const token = process.env.CONSOLE_TOKEN ?? ''
    if (token.length < 16) throw new Error('CONSOLE_TOKEN must be set to a secret of at least 16 characters (the console can change databases).')
    // In a container the process must listen on 0.0.0.0 (the published port is what limits who can reach it).
    const host = process.env.CONSOLE_HOST ?? config.host
    const port = process.env.CONSOLE_PORT ? Number(process.env.CONSOLE_PORT) : config.port
    createApp(engine, config, token).listen(port, host, () => {
      console.log(`migration-console on http://${host}:${port} — ${config.environments.map(e => `${e.name} (${e.mode})`).join(', ')}`)
    })
    return
  }
  const env = positional[0]
  if (!env) throw new Error(`${t('cli.needEnv')}\n\n${t('cli.help')}`)
  if (command === 'status') {
    const s = await engine.status(env)
    if (json) return console.log(JSON.stringify(s, null, 2))
    console.log(`${t('cli.status.head', { environment: s.environment, driver: s.driver, mode: s.mode })}${s.tracked ? '' : t('cli.status.untracked')}`)
    for (const m of s.migrations) console.log(`${t(`status.${m.status}`).padEnd(14)} ${m.version}_${m.name}${m.baselined ? t('cli.status.baselined') : ''}`)
    return
  }
  if (command === 'simulate') {
    const versions = positional.slice(1)
    const r = await engine.simulate(env, versions.length ? { versions } : {})
    return json ? console.log(JSON.stringify(r, null, 2)) : printSimulation(t, r)
  }
  if (command === 'apply') {
    const version = positional[1]
    if (!version) throw new Error(t('cli.needMigration'))
    await engine.simulate(env, { versions: [version] }).then(r => { if (!json) printSimulation(t, r); if (r.migrations.some(m => m.outcome !== 'ok')) throw new Error(t('cli.simFailed')) })
    const out = await engine.apply(env, { version, confirm: arg(args, '--confirm') ?? '', user: arg(args, '--user') ?? '' })
    return console.log(json ? JSON.stringify(out) : t(out.partial ? 'cli.appliedPartial' : 'cli.applied', { version: out.version, ms: out.durationMs }))
  }
  throw new Error(`${t('cli.unknownCommand', { command })}\n\n${t('cli.help')}`)
}

main().catch(e => {
  const t = translator(pickLang(arg(process.argv.slice(2), '--lang')))
  console.error(e instanceof ConsoleError ? t('cli.error', { code: e.code, message: t.has(`error.${e.code}`) ? t(`error.${e.code}`, e.details as Record<string, string | number>) : e.message }) : e instanceof Error ? e.message : e)
  process.exit(1)
})
