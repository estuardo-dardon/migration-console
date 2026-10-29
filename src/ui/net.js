/**
 * The net effect of the chain: what the database looks like at the end compared with the start. A column one script adds
 * and a later one drops is not a change; a column added and then altered is one addition.
 */
export function netChanges(migrations) {
  const net = new Map()
  for (const m of migrations) for (const c of m.changes) {
    const key = c.kind + '\u0000' + c.identity
    const cur = net.get(key)
    if (!cur) net.set(key, { kind: c.kind, identity: c.identity, before: c.type === 'added' ? undefined : c.before, after: c.type === 'removed' ? undefined : c.after, existedBefore: c.type !== 'added', existsAfter: c.type !== 'removed' })
    else { cur.after = c.type === 'removed' ? undefined : c.after; cur.existsAfter = c.type !== 'removed' }
  }
  const out = []
  for (const c of net.values()) {
    if (!c.existedBefore && !c.existsAfter) continue
    if (!c.existedBefore) out.push({ kind: c.kind, identity: c.identity, type: 'added', after: c.after })
    else if (!c.existsAfter) out.push({ kind: c.kind, identity: c.identity, type: 'removed', before: c.before })
    else if (c.before !== c.after) out.push({ kind: c.kind, identity: c.identity, type: 'changed', before: c.before, after: c.after })
  }
  return out
}
