import { describe, it, expect } from 'vitest'
import { splitStatements, stripComments, UnsupportedScriptError } from '../src/sql/splitter.js'

const texts = (sql: string, driver: 'postgres' | 'mysql' | 'mssql' = 'postgres') => splitStatements(sql, driver).map(s => s.text)

describe('splitStatements (postgres)', () => {
  it('splits on semicolons and drops empty pieces and comment-only pieces', () => {
    expect(texts('select 1;; -- nothing here\n select 2;\n/* only a comment */')).toEqual(['select 1', '-- nothing here\n select 2'])
  })

  it('does not split inside strings, quoted identifiers or comments', () => {
    expect(texts(`insert into t values ('a;b', 'it''s; ok'); select "we;ird" from x; -- a; b\nselect 3 /* c; d */`)).toHaveLength(3)
  })

  it('keeps a dollar-quoted function body in one piece, whatever it contains', () => {
    const fn = `create function f() returns void language plpgsql as $fn$ begin perform 1; perform 2; end; $fn$`
    expect(texts(`${fn}; select 1;`)).toEqual([fn, 'select 1'])
    expect(texts(`do $$ begin raise notice 'a;b'; end $$; select 2;`)).toHaveLength(2)
  })

  it('handles nested block comments (postgres) and escaped quotes', () => {
    expect(texts(`select 1 /* a /* b; */ c; */; select 2;`)).toEqual(['select 1 /* a /* b; */ c; */', 'select 2'])
  })

  it('reports the line where each statement really starts, comments and blank lines excluded', () => {
    const lines = splitStatements(`-- header\n\nselect 1;\n\n-- note\nselect\n 2;\n$$x$$;`, 'postgres').map(s => s.line)
    expect(lines).toEqual([3, 6, 8])
  })

  it('an unterminated string or dollar quote swallows the rest instead of crashing', () => {
    expect(texts(`select 'oops; select 2`)).toHaveLength(1)
    expect(texts(`select $$ oops; select 2`)).toHaveLength(1)
  })
})

describe('splitStatements (mysql / mssql)', () => {
  it('mysql: backtick identifiers, backslash escapes and # comments', () => {
    expect(texts("select `a;b`; select 'it\\'s; ok'; # c; d\nselect 3;", 'mysql')).toEqual(['select `a;b`', "select 'it\\'s; ok'", '# c; d\nselect 3'])
  })

  it('mysql: refuses DELIMITER rather than guessing', () => {
    expect(() => splitStatements('DELIMITER //\ncreate procedure p() begin select 1; end//\nDELIMITER ;', 'mysql')).toThrow(UnsupportedScriptError)
  })

  it('mssql: batches are separated by GO on its own line, not by semicolons', () => {
    const out = splitStatements('create table a (x int);\nselect 1;\nGO\nselect 2\ngo\n', 'mssql')
    expect(out.map(s => s.text)).toEqual(['create table a (x int);\nselect 1;', 'select 2'])
    expect(out.map(s => s.line)).toEqual([1, 4])
  })
})

describe('stripComments', () => {
  it('removes comments but not what looks like one inside a string', () => {
    expect(stripComments(`select '-- not a comment' -- real\n, 1 /* x */`)).toBe(`select '-- not a comment' \n, 1  `)
  })
})
