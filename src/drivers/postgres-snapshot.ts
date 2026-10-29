import type { Change } from '../types.js'

/** One database object, identified by kind + name, with a text that changes whenever its definition changes. */
export type Snapshot = Map<string, { kind: string; identity: string; definition: string }>

export interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }

const key = (kind: string, identity: string) => `${kind}\u0000${identity}`

/**
 * Catalog queries, one per kind of object. Each returns (kind, identity, definition). The definition is whatever
 * `pg_get_*def` gives, so a change in the object shows as a change in the text. Function bodies are hashed (they are
 * long); the diff then says "the body changed".
 */
const QUERIES: string[] = [
  // schemas (created by a migration)
  `select 'schema' as kind, nspname as identity, '' as definition from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'`,
  `select 'extension', extname, extversion from pg_extension`,
  // tables: kind + row level security
  `select 'table', n.nspname || '.' || c.relname,
          concat_ws(', ', case c.relkind when 'p' then 'partitioned table' else 'table' end,
                    case when c.relrowsecurity then 'RLS on' else 'RLS off' end, case when c.relforcerowsecurity then 'RLS forced' end)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = any($1) and c.relkind in ('r','p')`,
  `select 'column', n.nspname || '.' || c.relname || '.' || a.attname,
          format_type(a.atttypid, a.atttypmod)
          || case when a.attnotnull then ' not null' else '' end
          || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
          || case when a.attidentity <> '' then ' identity ' || a.attidentity::text else '' end
          || case when a.attgenerated <> '' then ' generated' else '' end
     from pg_attribute a
     join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
     left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attnum > 0 and not a.attisdropped and c.relkind in ('r','p') and n.nspname = any($1)`,
  `select 'index', schemaname || '.' || indexname, indexdef from pg_indexes where schemaname = any($1)`,
  `select 'constraint', n.nspname || '.' || c.relname || '.' || con.conname, pg_get_constraintdef(con.oid)
     from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = any($1)`,
  `select 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', 'body ' || left(md5(pg_get_functiondef(p.oid)), 10)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = any($1) and p.prokind in ('f','p')`,
  `select 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid)
     from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal and n.nspname = any($1)`,
  `select 'policy', schemaname || '.' || tablename || '.' || policyname,
          concat('for ', cmd, ' to ', roles::text, ' using (', coalesce(qual, ''), ') with check (', coalesce(with_check, ''), ')')
     from pg_policies where schemaname = any($1)`,
  `select 'enum', n.nspname || '.' || t.typname, string_agg(e.enumlabel, ', ' order by e.enumsortorder)
     from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = any($1) group by n.nspname, t.typname`,
  `select 'view', schemaname || '.' || viewname, 'definition ' || left(md5(definition), 10) from pg_views where schemaname = any($1)`,
  `select 'view', schemaname || '.' || matviewname, 'materialized, definition ' || left(md5(definition), 10) from pg_matviews where schemaname = any($1)`,
  // permissions: GRANT / REVOKE show up here
  `select 'acl', c.relkind::text || ' ' || n.nspname || '.' || c.relname, coalesce(c.relacl::text, '(default)')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r','p','v','m') and n.nspname = any($1)`,
  `select 'acl', 'function ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', coalesce(p.proacl::text, '(default)')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = any($1) and p.prokind in ('f','p')`,
]

export async function takeSnapshot(db: Queryable, schemas: string[]): Promise<Snapshot> {
  const snap: Snapshot = new Map()
  for (const q of QUERIES) {
    // Name the columns once, here, instead of in every query.
    const { rows } = await db.query(`with q(kind, identity, definition) as (${q}) select kind, identity, definition from q`, q.includes('$1') ? [schemas] : [])
    for (const r of rows) snap.set(key(r.kind, r.identity), { kind: r.kind, identity: r.identity, definition: r.definition ?? '' })
  }
  return snap
}

/** What a script changed: objects it created, removed, or whose definition is not the same any more. */
export function diffSnapshots(before: Snapshot, after: Snapshot): Change[] {
  const out: Change[] = []
  // Permissions of an object are "(default)" until someone grants something: creating or dropping an object with the
  // default permissions is not a permissions change.
  const isDefaultAcl = (e: { kind: string; definition: string }) => e.kind === 'acl' && e.definition === '(default)'
  for (const [k, a] of after) {
    const b = before.get(k)
    if (!b && isDefaultAcl(a)) continue
    if (!b) out.push({ kind: a.kind, identity: a.identity, type: 'added', after: a.definition })
    else if (b.definition !== a.definition) out.push({ kind: a.kind, identity: a.identity, type: 'changed', before: b.definition, after: a.definition })
  }
  for (const [k, b] of before) if (!after.has(k) && !isDefaultAcl(b)) out.push({ kind: b.kind, identity: b.identity, type: 'removed', before: b.definition })
  const order = ['schema', 'extension', 'enum', 'table', 'column', 'constraint', 'index', 'function', 'trigger', 'policy', 'view', 'acl']
  return out.sort((x, y) => (order.indexOf(x.kind) - order.indexOf(y.kind)) || x.identity.localeCompare(y.identity))
}
