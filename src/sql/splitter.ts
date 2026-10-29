import type { DriverName } from '../types.js'

export interface RawStatement { text: string; line: number }

/**
 * Split a script into statements without being fooled by semicolons inside strings, quoted identifiers, comments or
 * dollar-quoted bodies (`$$ … $$`, `$fn$ … $fn$`). Comments are kept in the text (they are harmless to run) but a
 * piece with nothing but comments is dropped.
 *
 * SQL Server separates batches with a line holding only `GO`, not with semicolons; MySQL's `DELIMITER` command is not
 * supported (the script is refused rather than guessed at).
 */
export class UnsupportedScriptError extends Error {}

export function splitStatements(sql: string, driver: DriverName = 'postgres'): RawStatement[] {
  return driver === 'mssql' ? splitBatches(sql) : splitSemicolons(sql, driver)
}

const hasCode = (s: string) => stripComments(s).trim() !== ''

/** The text without `--`, `#` (MySQL) and block comments; strings are left as they are. */
export function stripComments(sql: string, driver: DriverName = 'postgres'): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]!, d = sql[i + 1]
    if (c === '-' && d === '-') { while (i < n && sql[i] !== '\n') i++; continue }
    if (c === '#' && driver === 'mysql') { while (i < n && sql[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') {
      let depth = 1; i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*' && driver === 'postgres') { depth++; i += 2 }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2 }
        else i++
      }
      out += ' '
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      out += c; i++
      while (i < n) {
        const e = sql[i]!
        out += e; i++
        if (e === '\\' && driver === 'mysql' && i < n) { out += sql[i]; i++; continue }
        if (e === q) { if (sql[i] === q) { out += sql[i]; i++; continue } break }
      }
      continue
    }
    if (c === '$' && driver === 'postgres') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        const stop = end === -1 ? n : end + tag.length
        out += sql.slice(i, stop); i = stop
        continue
      }
    }
    out += c; i++
  }
  return out
}

/** Offset of the first character that is neither whitespace nor part of a comment. */
function firstCodeOffset(text: string): number {
  let i = 0
  while (i < text.length) {
    if (/\s/.test(text[i]!)) { i++; continue }
    if (text[i] === '-' && text[i + 1] === '-') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (text[i] === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end === -1 ? text.length : end + 2; continue }
    break
  }
  return i
}

function splitSemicolons(sql: string, driver: DriverName): RawStatement[] {
  if (driver === 'mysql' && /^\s*DELIMITER\s/im.test(stripComments(sql, 'mysql'))) {
    throw new UnsupportedScriptError('The DELIMITER command is not supported: split the script so that every statement ends in ";"')
  }
  const out: RawStatement[] = []
  let start = 0, line = 1, startLine = 1
  let i = 0
  const n = sql.length
  const push = (end: number) => {
    const text = sql.slice(start, end)
    if (hasCode(text)) {
      // The statement's line is that of its first text that is not blank or a comment.
      const leadLines = (text.slice(0, firstCodeOffset(text)).match(/\n/g) ?? []).length
      out.push({ text: text.trim(), line: startLine + leadLines })
    }
  }
  while (i < n) {
    const c = sql[i]!, d = sql[i + 1]
    if (c === '\n') { line++; i++; continue }
    if ((c === '-' && d === '-') || (c === '#' && driver === 'mysql')) { while (i < n && sql[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') {
      let depth = 1; i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '\n') line++
        if (sql[i] === '/' && sql[i + 1] === '*' && driver === 'postgres') { depth++; i += 2 }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2 }
        else i++
      }
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      i++
      while (i < n) {
        const e = sql[i]!
        if (e === '\n') line++
        i++
        if (e === '\\' && driver === 'mysql' && i < n) { i++; continue }
        if (e === q) { if (sql[i] === q) { i++; continue } break }
      }
      continue
    }
    if (c === '$' && driver === 'postgres') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        const stop = end === -1 ? n : end + tag.length
        line += (sql.slice(i, stop).match(/\n/g) ?? []).length
        i = stop
        continue
      }
    }
    if (c === ';') { push(i); i++; start = i; startLine = line; continue }
    i++
  }
  push(n)
  return out
}

function splitBatches(sql: string): RawStatement[] {
  const out: RawStatement[] = []
  const lines = sql.split(/\r?\n/)
  let buf: string[] = []
  let startLine = 1
  const flush = () => {
    const text = buf.join('\n')
    if (hasCode(text)) out.push({ text: text.trim(), line: startLine })
    buf = []
  }
  lines.forEach((l, idx) => {
    if (/^\s*GO\s*$/i.test(l)) { flush(); startLine = idx + 2; return }
    if (buf.length === 0) startLine = idx + 1
    buf.push(l)
  })
  flush()
  return out
}
