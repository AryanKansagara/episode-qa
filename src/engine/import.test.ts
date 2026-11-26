import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoMap, build, detectKind, merge, parseCsv, readTable } from './parse.ts'
import type { Episode } from './types.ts'

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

// Cells written by pandas 2.3.3 / numpy 2.2.6 / pyarrow 20 with the command in Docs.
test('numpy arrays wrapped over several lines become columns, and line numbers stay physical', () => {
  const seven = '"[ 0.27646735  0.6572945   0.26434967 -1.0425258   0.7242847   0.35709965\n -0.4295626 ]"'
  const csv = 'observation.state,episode_index,timestamp\n' + [0, 1, 2, 3].map(k => `${seven},0,${k === 2 ? 'soon' : k / 50}\n`).join('') + `${seven},0,0.08\n`
  const b = imp(csv)
  assert.deepEqual(b.episodes[0].q[0], [0.27646735, 0.6572945, 0.26434967, -1.0425258, 0.7242847, 0.35709965, -0.4295626])
  assert.equal(b.issues[0].line, 6)
  const fourteen = '"[ 0.27646735  0.6572945   0.26434967 -1.0425258   0.7242847   0.35709965\r\n -0.4295626   0.46489447  0.29165792  0.235306    0.02273779  0.4373704\r\n -0.58916324 -0.13032795]"'
  const t = parseCsv('observation.state,episode_index,timestamp\r\n' + `${fourteen},0,0\r\n`)
  assert.equal(t.headers.length, 16)
  assert.equal(t.rows[0][13], '-0.13032795')
  assert.equal(parseCsv('note,x\n"[moved\nfast]",1\n').headers.length, 2)
  assert.equal(parseCsv('a,x\n"[1. nan\n 3.e-05]",1\n').headers.length, 4)
})

test('200,000 frames import, with the gripper scale and degrees found in the last row', () => {
  const N = 200_000
  const csv = 'episode_index,timestamp,q0,q1,gripper\n' + Array.from({ length: N }, (_, i) => `${Math.floor(i / 1000)},${(i % 1000) / 10},${i === N - 1 ? 90 : 0.1},0.2,${i === N - 1 ? 85 : 42.5}`).join('\n')
  const b = imp(csv)
  assert.equal(b.episodes.length, 200)
  assert.ok(Math.abs(b.episodes[199].q[999][0] - Math.PI / 2) < 1e-12)
  assert.equal(b.episodes[0].grip![0], 0.5)
})

const episode = (): Episode => ({ id: 'a', task: 'pick', operator: 'ana', success: false, tags: ['rig-1'], t: [0, 1], q: [[0], [0]], cams: {} })
const attach = (csv: string) => { const b = imp(csv); return { e: merge([episode()], b).ds[0], b } }

test('blank or unreadable metadata keeps what is known; readable values replace it', () => {
  const blank = attach('episode_index,task,operator,success,tags\na, ,  ,,\n').e
  assert.deepEqual(blank, episode())
  const odd = attach('episode_index,success\na,maybe\n')
  assert.equal(odd.e.success, false)
  assert.match(odd.b.issues[0].message, /"maybe" not understood/)
  const set = attach('episode_index,task,operator,success,tags\na,place,ben,true,x;y\n').e
  assert.deepEqual([set.task, set.operator, set.success, set.tags], ['place', 'ben', true, ['x', 'y']])
  assert.equal(attach('episode_index,success\na,true\na,\n').e.success, true, 'a later blank row for the same episode')
  assert.equal(attach('episode_index,success\na,true\na,false\n').e.success, false, 'the last readable row wins')
})

test('an unreadable success value in frames is warned about once and does not replace a readable one', () => {
  const b = imp('episode_index,timestamp,q0,q1,success\n' + ['false', '', 'maybe', 'maybe', ''].map((s, k) => `a,${k},0,0,${s}\n`).join(''))
  assert.equal(b.episodes[0].success, false)
  assert.equal(b.issues.filter(i => /not understood/.test(i.message)).length, 1)
})
