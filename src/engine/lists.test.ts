import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoMap, build, detectKind, parseCsv, readTable } from './parse.ts'

const imp = (text: string) => { const t = readTable('f.csv', text); const m = autoMap(t.headers); return build(t, detectKind(t.headers, m), m, 'f.csv') }
const cell = (s: string) => `"${s.replace(/"/g, '""')}"`
const meta = (...cells: string[]) => imp('episode_index,tasks,tags\n' + cells.map((c, i) => `${i},${cell("['cube to bin']")},${cell(c)}\n`).join('')).meta

test('task and tag lists keep whole strings, without quotes, for every row length', () => {
  const m = meta("['rig-1']", "['rig-1', 'low light', 'x']", '[]', '', '["it\'s", "a, b"]', "['one' 'two words']", "['first'\n 'second one']")
  assert.ok(Object.values(m).every(x => x.task === 'cube to bin'))
  assert.deepEqual(Object.values(m).map(x => x.tags ?? null), [['rig-1'], ['rig-1', 'low light', 'x'], null, null, ["it's", 'a, b'], ['one', 'two words'], ['first', 'second one']])
})

test('other ways to write text lists', () => {
  assert.deepEqual(meta('[rig-1, low light]')[0].tags, ['rig-1', 'low light'])
  assert.deepEqual(meta("[operator's cup, b]")[0].tags, ["operator's cup", 'b'])
  assert.deepEqual(meta('["say \\"hi\\"", \'it\\\'s\', None, "caf\\u00e9"]')[0].tags, ['say "hi"', "it's", 'café'])
  assert.deepEqual(meta('[]', "['late']")[1].tags, ['late'], 'the first row is empty')
  assert.deepEqual(meta('', "['late']")[1].tags, ['late'], 'the first row is blank')
  assert.deepEqual(Object.values(meta('plain', "['a', 'b c']", "['d']")).map(x => x.tags), [['plain'], ['a', 'b c'], ['d']])
  assert.equal(meta('[]', '[]')[0].tags, undefined, 'an empty list is no tag')
  const quoted = imp('episode_index,timestamp,qpos\n' + [0, 1, 2, 3].map(k => `0,${k / 10},"['0.${k}', '1']"\n`).join(''))
  assert.deepEqual(quoted.episodes[0].q[2], [0.2, 1])
})

test('number arrays: one damaged row does not change the columns of the others', () => {
  const rows = (bad: string, at: number) => 'episode_index,timestamp,qpos\n' + [0, 1, 2, 3, 4, 5].map(k => `0,${k / 10},${cell(k === at ? bad : `[0.${k} 1. nan]`.replace('nan', '2'))}\n`).join('')
  for (const at of [0, 3]) for (const bad of ['[0.1 x 0.2]', '[0.1 0.2]', '', 'oops', '[0.1 1.']) {
    const b = imp(rows(bad, at))
    assert.equal(b.episodes[0]?.t.length, 5, `${bad} at ${at}`)
    assert.equal(b.episodes[0].q[0].length, 3)
    assert.equal(b.skipped, 1)
    assert.equal(b.issues[0].line, at + 2)
  }
  assert.deepEqual(imp(rows('[0.1 1. 2. 9.]', 3)).episodes[0].q[0].length, 3)
})

test('columns that are not lists are left alone', () => {
  assert.deepEqual(parseCsv('note,x\n[a] b,1\n[c] d,2\n').headers, ['note', 'x'])
  assert.deepEqual(parseCsv('note,x\nplain,1\nalso plain,2\n[c],3\n').rows[2], ['[c]', '3'])
  assert.equal(parseCsv('note,x\n"[moved\nfast]",1\n').headers.length, 2)
})
