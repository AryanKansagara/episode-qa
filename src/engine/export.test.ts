import { test } from 'node:test'
import assert from 'node:assert/strict'
import { curate, decisionsCsv, decisionsJson } from './curate.ts'
import { parseCsv } from './parse.ts'
import type { EpisodeStats } from './types.ts'

const st = (over: Partial<EpisodeStats>) => ({ id: 'a', task: 't', operator: 'o', success: true, tags: [], duration: 10, frames: 301, score: 80, issues: [], trim: [0, 10], trimFrames: [0, 300], ...over } as unknown as EpisodeStats)
const csv = (s: EpisodeStats) => decisionsCsv([s], curate([s], [], {}, { dupDrop: new Set() }))

test('text that starts a formula is neutralised in every text column', () => {
  for (const x of ['=1+1', '+A1', '-A1', '@SUM(A1)', '\t=1', '\r=1', '\n=1', '=HYPERLINK("http://example.com")', '-1+2', '+', '-1e5x', '--1']) {
    const r = parseCsv(csv(st({ id: x, task: x, operator: x, tags: [x, 'b'] }))).rows[0]
    assert.deepEqual([r[0], r[1], r[2], r[10]], [`'${x}`, `'${x}`, `'${x}`, `'${x};b`], JSON.stringify(x))
  }
})

test('numbers stay numbers and other text is unchanged', () => {
  for (const x of ['-1', '+5', '-0.25', 'a=b', 'pick - place', 'ep_1', "'quoted'", '']) assert.equal(parseCsv(csv(st({ task: x }))).rows[0][1], x)
  assert.equal(csv(st({})).split('\n')[1], 'a,t,o,true,true,0.000,10.000,0,300,80,,')
})

test('a lone carriage return does not break the row', () => {
  const text = csv(st({ task: 'a\rb' }))
  assert.ok(text.includes('"a\rb"'))
  const t = parseCsv(text)
  assert.equal(t.rows.length, 1)
  assert.equal(t.rows[0][1], 'a\rb')
})

test('JSON keeps the original text', () => {
  const s = st({ task: '=1+1' })
  assert.equal(decisionsJson([s], curate([s], [], {}, { dupDrop: new Set() }), []).episodes[0].task, '=1+1')
})
