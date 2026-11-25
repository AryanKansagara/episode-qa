import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoMap, build, detectKind, parseCsv, readTable } from './parse.ts'

const imp = (text: string, name = 'f.csv') => { const t = readTable(name, text); const m = autoMap(t.headers); return build(t, detectKind(t.headers, m), m, name) }
const FRAMES = 'q0,q1,timestamp,episode_index,gripper,success\n' + [0, 1, 2, 3, 4].map(k => `${k / 10},0,${k / 10},a,1,true\n`).join('')

test('a file cut at any byte never throws, and never turns the cut row into a frame unless only its last cell is cut', () => {
  const start = FRAMES.indexOf('\n') + 1
  for (let i = 0; i <= FRAMES.length; i++) {
    const cut = FRAMES.slice(0, i)
    const b = imp(cut)
    const lines = cut.slice(start).split('\n')
    const whole = i < start ? 0 : lines.filter(l => l.split(',').length === 6).length
    assert.equal(b.episodes.reduce((a, e) => a + e.t.length, 0), whole >= 4 ? whole : 0, JSON.stringify(cut.slice(-20)))
  }
})

test('short rows: metadata, cameras and frames', () => {
  const meta = imp('episode_index,task,success\na,x,true\nb')
  assert.deepEqual(Object.keys(meta.meta), ['a'])
  assert.equal(meta.skipped, 1)
  assert.equal(meta.issues[0].line, 3)
  const cams = imp('episode_index,timestamp,camera\na,1,w\na,2')
  assert.deepEqual(cams.cams, { a: { w: [1] } })
  assert.equal(cams.skipped, 1)
  const mid = imp('q0,q1,timestamp,episode_index,gripper\n0,0,0,a,1\n0,0,.1,a,1\n0,0,.2\n0,0,.3,a\n0,0,.4,a,1\n0,0,.5,a,1\n')
  assert.equal(mid.episodes[0].t.length, 5, 'the row without an id is skipped, the one without a gripper value stays')
  assert.equal(mid.skipped, 1)
  assert.ok(mid.issues.some(x => x.line === 4 && x.level === 'warn' && /2 rows have fewer cells/.test(x.message)))
})

test('an unclosed quote is an error on the line it opened', () => {
  const b = imp('episode_index,timestamp,q0,q1,task\n' + Array.from({ length: 10 }, (_, i) => `a,${i / 10},0,0,${i === 4 ? '"pick' : 'pick'}`).join('\n'))
  assert.equal(b.issues[0].line, 6)
  assert.equal(b.issues[0].level, 'error')
  assert.equal(b.episodes[0].t.length, 4)
  assert.match(imp('episode_index,timestamp,q0,q1\na,0,0,0\na,1,0,"').issues[0].message, /never closed/)
})

test('complete files are read as before', () => {
  assert.equal(parseCsv('a,b\n1,2\n3,4').problems, undefined)
  assert.equal(parseCsv('a,b\n1,2\n3,4\n').problems, undefined)
  assert.equal(parseCsv('a,b\n1,2,\n3,4,,').rows.length, 2)
  assert.deepEqual(parseCsv('a,b\n1,"x\ny"').rows, [['1', 'x\ny']])
  assert.equal(parseCsv('a,b,\n1,2,\n3,4').problems, undefined)
  // Every row leaves out the trailing cells: that is how the file is written, not a cut.
  assert.equal(parseCsv('a,b,c\n1,2\n3,4').rows.length, 2)
})
