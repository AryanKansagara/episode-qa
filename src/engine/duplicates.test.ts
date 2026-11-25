import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultConfig } from './analyze.ts'
import { curate, type Override, type Rule } from './curate.ts'
import { derive } from '../projectData.ts'
import type { EpisodeStats } from './types.ts'

const line = (y: number) => Array.from({ length: 32 }, (_, i) => [i / 31, y, 0])
const st = (id: string, y: number, score = 90) => ({ id, task: 't', operator: 'o', success: true, tags: [], duration: 1, frames: 30, score, grasps: [], issues: [], trim: [0, 1], trimFrames: [0, 29], path: line(y) } as unknown as EpisodeStats)
const rule = (field: Rule['field'], op: Rule['op'], value: string, action: Rule['action'] = 'exclude'): Rule => ({ id: field, field, op, value, action, enabled: true })
const DUP = rule('duplicate', '=', 'true')
const kept = (stats: EpisodeStats[], rules: Rule[], o: Record<string, Override> = {}) => {
  const d = derive(stats, {}, defaultConfig(), rules, o)
  return { ids: curate(stats, rules, o, d.ctx).filter(x => x.include).map(x => x.id), ...d }
}

test('excluding the kept copy promotes the next one, by hand or by another rule', () => {
  const copies = [st('a', 0, 90), st('b', 0, 80), st('c', 0, 70)]
  assert.deepEqual(kept(copies, [DUP]).ids, ['a'])
  assert.deepEqual(kept(copies, [DUP], { a: 'exclude' }).ids, ['b'])
  assert.deepEqual(kept(copies, [DUP], { a: 'exclude', b: 'exclude' }).ids, ['c'])
  assert.deepEqual(kept(copies, [DUP, rule('score', '>', '85')]).ids, ['b'])
  assert.deepEqual(kept(copies, [DUP], { b: 'keep' }).ids, ['a', 'b'])
  assert.deepEqual(kept(copies, [DUP, rule('score', '<', '95')]).ids, [], 'all are excluded by something else')
  assert.deepEqual(kept(copies, [DUP, rule('score', '<', '95'), rule('score', '<', '75', 'keep')]).ids, ['c'])
})

test('an episode that is not within the limit of a kept one is not dropped', () => {
  const r = kept([st('A', 0), st('B', 0.005), st('C', 0.010)], [DUP])
  assert.deepEqual(r.ids, ['A', 'C'])
  assert.deepEqual(r.clusters, [{ keep: 'A', drop: ['B'] }])
  assert.deepEqual(kept([st('A', 0), st('B', 0.005, 95), st('C', 0.010)], [DUP]).ids, ['B'], 'the middle one covers both')
})

test('random paths: every dropped episode has a kept one within the limit, and no two kept ones are copies', () => {
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let n = 0; n < 200; n++) {
    const stats = Array.from({ length: 12 }, (_, i) => st(`e${i}`, rnd() * 0.04, Math.round(rnd() * 100)))
    const o: Record<string, Override> = {}
    for (const s of stats) if (rnd() < 0.2) o[s.id] = 'exclude'
    const rules = [DUP, rule('score', '<', '30')]
    const r = kept(stats, rules, o)
    const inc = new Set(r.ids)
    const dupOnly = curate(stats, rules, o, r.ctx).filter(d => !d.include && d.reasons.length === 1 && /near-duplicate/.test(d.reasons[0]))
    for (const d of dupOnly) assert.ok(r.pairs.some(p => (p.a === d.id && inc.has(p.b)) || (p.b === d.id && inc.has(p.a))), d.id)
    for (const p of r.pairs) assert.ok(!(inc.has(p.a) && inc.has(p.b)))
  }
})
