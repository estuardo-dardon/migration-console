import { describe, it, expect } from 'vitest'
import { analyze, classify, parseScript, summarize, touchedTables } from '../src/sql/analyze.js'

const find = (sql: string, driver: 'postgres' | 'mysql' | 'mssql' = 'postgres') => analyze(parseScript(sql, driver), driver).map(f => f.code)

describe('classify', () => {
  it.each([
    ['BEGIN', 'transaction-control'], ['commit', 'transaction-control'], ['END', 'transaction-control'], ['rollback', 'transaction-control'], ['SAVEPOINT a', 'transaction-control'],
    ['start transaction', 'transaction-control'],
    ['create table x (a int)', 'ddl'], ['ALTER TABLE x ADD COLUMN b int', 'ddl'], ['grant select on x to y', 'ddl'],
    ['insert into x values (1)', 'dml'], ['update x set a = 1 where b = 2', 'dml'], ['delete from x where a = 1', 'dml'],
    ['select 1', 'query'], ['with a as (select 1) select * from a', 'query'],
    ['set local x = 1', 'other'],
  ])('%s → %s', (sql, kind) => { expect(classify(sql, 'postgres').kind).toBe(kind) })

  it('BEGIN ATOMIC (a function body) is not a transaction', () => {
    expect(classify('BEGIN ATOMIC select 1; END', 'postgres').kind).not.toBe('transaction-control')
  })

  it('flags what cannot run in a transaction', () => {
    for (const sql of ['create index concurrently i on t (a)', 'CREATE UNIQUE INDEX CONCURRENTLY i ON t (a)', 'vacuum t', 'create database d', 'alter system set x = 1', 'drop index concurrently i', 'refresh materialized view concurrently v']) {
      expect(classify(sql, 'postgres').nonTransactional, sql).toBe(true)
    }
    expect(classify('create index i on t (a)', 'postgres').nonTransactional).toBe(false)
  })
})

describe('summarize', () => {
  it('names the statement and its object', () => {
    expect(summarize('ALTER TABLE public.countries\n ADD COLUMN x int', 'postgres')).toBe('ALTER TABLE public.countries')
    expect(summarize('create or replace function public.f() returns int as $$ select 1 $$ language sql', 'postgres')).toBe('CREATE OR REPLACE FUNCTION public.f')
    expect(summarize('INSERT INTO public.parameters (a) values (1)', 'postgres')).toBe('INSERT INTO public.parameters')
    expect(summarize('create index concurrently if not exists i on t(a)', 'postgres')).toBe('CREATE INDEX CONCURRENTLY IF NOT EXISTS i')
  })
})

describe('analyze: what to warn about', () => {
  it('destructive statements are danger', () => {
    expect(find('drop table x')).toContain('drop-table')
    expect(find('alter table x drop column y')).toContain('drop-column')
    expect(find('truncate x')).toContain('truncate')
  })

  it('a DELETE / UPDATE without WHERE is danger; with WHERE it is not', () => {
    expect(find('delete from x')).toContain('delete-no-where')
    expect(find('update x set a = 1')).toContain('update-no-where')
    expect(find('delete from x where a = 1')).not.toContain('delete-no-where')
    expect(find('update x set a = 1 where b = 2')).not.toContain('update-no-where')
    expect(find(`insert into x values (1) on conflict (a) do update set b = 2`)).not.toContain('update-no-where')
  })

  it('dropping a constraint, a default or a NOT NULL is not "drop column"', () => {
    for (const sql of ['alter table x drop constraint c', 'alter table x alter column a drop default', 'alter table x alter column a drop not null']) expect(find(sql), sql).not.toContain('drop-column')
  })

  it('locks and rewrites', () => {
    expect(find('alter table x alter column a type bigint')).toContain('alter-type')
    expect(find('alter table x alter column a set not null')).toContain('set-not-null')
    expect(find('alter table x add column a uuid default gen_random_uuid()')).toContain('add-column-volatile-default')
    expect(find('alter table x add column a boolean default true')).not.toContain('add-column-volatile-default')
    expect(find('create index i on x (a)')).toContain('index-blocks-writes')
    expect(find('create index concurrently i on x (a)')).not.toContain('index-blocks-writes')
    expect(find('create index concurrently i on x (a)')).toContain('non-transactional')
    expect(find('alter table x add column a int')).toContain('alter-table-lock')
  })

  it('effects outside the database and enum values', () => {
    expect(find(`select net.http_post('http://x')`)).toContain('external-effect')
    expect(find(`copy x from program 'ls'`)).toContain('copy-program')
    expect(find(`alter type e add value 'v'`)).toContain('enum-add-value')
  })

  it('transaction control is reported as ignored, and nothing else is said about it', () => {
    expect(find('begin; commit;')).toEqual(['transaction-control', 'transaction-control'])
  })

  it('mysql: DDL commits implicitly', () => {
    expect(find('alter table x add column a int', 'mysql')).toContain('implicit-commit')
    expect(find('insert into x values (1)', 'mysql')).not.toContain('implicit-commit')
    expect(find('alter table x add column a int', 'postgres')).not.toContain('implicit-commit')
  })

  it('every finding says where it is', () => {
    const [f] = analyze(parseScript('select 1;\n\ndrop table x;', 'postgres'), 'postgres')
    expect(f).toMatchObject({ statement: 2, line: 3, level: 'danger' })
  })
})

describe('touchedTables', () => {
  it('returns each table with and without the public schema', () => {
    const t = touchedTables(parseScript('alter table public.countries add column a int; create unique index i on parameters (key); insert into "public"."users" values (1); update ONLY x set a = 1 where b = 2', 'postgres'), 'postgres')
    expect(t).toEqual(expect.arrayContaining(['public.countries', 'countries', 'parameters', 'public.parameters', 'users', 'x', 'public.x']))
  })
})
