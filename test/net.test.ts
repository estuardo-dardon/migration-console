import { describe, it, expect } from 'vitest'
import { netChanges } from '../src/ui/net.js'

const m = (...changes: any[]) => ({ changes })
const add = (identity: string, after = 'x', kind = 'column') => ({ kind, identity, type: 'added', after })
const del = (identity: string, before = 'x', kind = 'column') => ({ kind, identity, type: 'removed', before })
const chg = (identity: string, before: string, after: string, kind = 'column') => ({ kind, identity, type: 'changed', before, after })

describe('netChanges: the effect of a whole chain, not of each step', () => {
  it('something added and later dropped is no change at all', () => {
    expect(netChanges([m(add('t.status')), m(del('t.status'))])).toEqual([])
  })

  it('added and then altered is one addition with the final definition', () => {
    expect(netChanges([m(add('t.a', 'int')), m(chg('t.a', 'int', 'bigint'))])).toEqual([{ kind: 'column', identity: 't.a', type: 'added', after: 'bigint' }])
  })

  it('altered twice is one change from the original to the last', () => {
    expect(netChanges([m(chg('t.a', 'int', 'bigint')), m(chg('t.a', 'bigint', 'text'))])).toEqual([{ kind: 'column', identity: 't.a', type: 'changed', before: 'int', after: 'text' }])
  })

  it('altered and put back is no change', () => {
    expect(netChanges([m(chg('t.a', 'int', 'bigint')), m(chg('t.a', 'bigint', 'int'))])).toEqual([])
  })

  it('removed and created again is a change, not a removal', () => {
    expect(netChanges([m(del('t.a', 'int')), m(add('t.a', 'text'))])).toEqual([{ kind: 'column', identity: 't.a', type: 'changed', before: 'int', after: 'text' }])
  })

  it('keeps unrelated changes and does not mix kinds with the same name', () => {
    const out = netChanges([m(add('x', 'a', 'table'), add('x', 'b', 'index')), m(del('y', 'c', 'view'))])
    expect(out.map(c => `${c.type}:${c.kind}:${c.identity}`)).toEqual(['added:table:x', 'added:index:x', 'removed:view:y'])
  })
})
