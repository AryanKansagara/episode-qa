import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoMap, build, detectKind, merge, parseCsv, parseStamp, readTable } from './parse.ts'
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

const stampFile = (id: string, stamps: (number | string)[]) => imp('episode_index,timestamp,q0,q1\n' + stamps.map(x => `${id},${x},0,0\n`).join(''))
const hz = (b: ReturnType<typeof imp>) => { const t = b.episodes[0].t; return Math.round((t.length - 1) / t.at(-1)!) }

test('relative ms, us and ns columns are 30 Hz, with a warning that names the unit', () => {
  for (const [k, name] of [[1e3, 'milliseconds'], [1e6, 'microseconds'], [1e9, 'nanoseconds']] as const) {
    // 5000 frames: in ns the values pass 1e11, the old per-value limit.
    const b = stampFile('a', Array.from({ length: 5000 }, (_, i) => Math.floor(i / 30 * k)))
    assert.equal(hz(b), 30, name)
    assert.ok(b.issues.some(i => i.level === 'warn' && i.message.includes(name)), name)
    assert.ok(!b.issues.some(i => /out of order/.test(i.message)), name)
  }
  const uptime = stampFile('a', Array.from({ length: 300 }, (_, i) => 2.5e12 + Math.floor(i / 30 * 1e9)))
  assert.equal(hz(uptime), 30, 'a clock that counts ns since boot')
})

test('relative seconds and epoch stamps are read as before, without a warning', () => {
  for (const [start, k] of [[0, 1], [1.7e9, 1], [1.7e9, 1e3], [1.7e9, 1e6], [1.7e9, 1e9]]) {
    const raw = Array.from({ length: 60 }, (_, i) => k === 1 ? (start + i / 30).toFixed(4) : `${BigInt(start * k) + BigInt(Math.floor(i / 30 * k))}`)
    const b = stampFile('a', raw)
    assert.equal(hz(b), 30)
    assert.deepEqual(b.issues, [], `${start} ${k}`)
    assert.equal(b.episodes[0].t0, parseStamp(raw[0]))
  }
})

test('unclear or mixed timestamp units warn, and the unit can be set', () => {
  const one = stampFile('a', [0, 1, 2, 3, 4])
  assert.deepEqual(one.episodes[0].t, [0, 1, 2, 3, 4])
  assert.match(one.issues[0].message, /unclear/)
  const csv = 'episode_index,timestamp,q0,q1\n' + [0, 1, 2, 3, 4, 5].flatMap(k => [`a,${k * 33},0,0`, `b,${k * 33}000000,0,0`, `c,${k * 33},0,0`]).join('\n')
  assert.match(imp(csv).issues[0].message, /all read as milliseconds, but some episodes look like nanoseconds/)
  assert.match(stampFile('a', [1.7e9, 1.7e9 + 1, 1.7e9 + 2, 1700000000500, 1700000001500]).issues[0].message, /mix units/)
  const t = readTable('f.csv', 'episode_index,timestamp,q0,q1\n' + [0, 1, 2, 3].map(k => `a,${k},0,0\n`).join(''))
  const b = build(t, 'frames', { ...autoMap(t.headers), stamps: 'ms' })
  assert.deepEqual(b.episodes[0].t, [0, 0.001, 0.002, 0.003])
  assert.deepEqual(b.issues, [])
})

test('camera files and shuffled rows: gaps are taken per stream', () => {
  const b = imp('episode_index,camera,timestamp\n' + [0, 1, 2, 3].flatMap(k => [`a,w,${k * 33}`, `a,h,${k * 33 + 1}`]).join('\n'))
  assert.deepEqual(b.cams.a.w, [0, 0.033, 0.066, 0.099])
  const n = 300, shuffled = Array.from({ length: n }, (_, i) => ((i * 113) % n) / 30)
  assert.equal(hz(stampFile('a', shuffled)), 30)
})

test('text that is not ISO 8601 is not a timestamp', () => {
  for (const x of ['frame 1', 'run-3', 'demo 12', 'Jan 5 2024', '1/2/2024', '2024-13-01', '2024-02-30', '2024-1-5', 'x2024-01-01', '2024-01-01 at 5', '2024-01-01T25:00:00Z', '1.2.3', '.', 'e5'])
    assert.ok(Number.isNaN(parseStamp(x)), x)
  const b = stampFile('A', [1, 2, 3, 4, 5].map(k => `frame ${k}`))
  assert.equal(b.episodes.length, 0)
  assert.deepEqual(b.issues.map(i => i.line), [2, 3, 4, 5, 6])
  assert.match(b.issues[0].message, /"frame 1" is not a number or ISO date/)
})

test('ISO 8601 forms and plain numbers without a leading or trailing digit', () => {
  const at = Date.UTC(2026, 10, 1, 0, 0, 1) / 1000
  for (const x of ['2026-11-01T00:00:01Z', '2026-11-01t00:00:01z', '2026-11-01 00:00:01+00:00', '2026-11-01T01:00:01+0100', '2026-10-31T23:00:01-01', '2026-11-01T00:00:01.000000+00:00', '2026-11-01T00:00:01,000Z'])
    assert.equal(parseStamp(x), at, x)
  assert.equal(parseStamp('2026-11-01T00:00:01.033333+00:00'), at + 0.033)
  assert.equal(parseStamp('2026-11-01'), Date.UTC(2026, 10, 1) / 1000)
  assert.equal(parseStamp('2026-11-01 00:00:01'), new Date(2026, 10, 1, 0, 0, 1).getTime() / 1000, 'no offset: local time')
  assert.deepEqual(['.5', '5.', '+1.5', '-.5', '1.e-3'].map(x => parseStamp(x)), [0.5, 5, 1.5, -0.5, 0.001])
})

test('frames without an episode column: several recordings are an error, a single one imports', () => {
  const rec = (n: number, from = 0) => Array.from({ length: n }, (_, k) => from + k / 10)
  const file = (ts: number[]) => imp('demo_name,timestamp,q0,q1\n' + ts.map(x => `d,${x.toFixed(2)},0,0\n`).join(''), 'demo.csv')
  for (const [ts, what] of [[[...rec(6), ...rec(6)], 'equal'], [[...rec(60), ...rec(8)], 'a short one after a long one'], [[...rec(8), ...rec(60)], 'a long one after a short one'], [[...rec(50), ...rec(50, 0.05)], 'shifted']] as const) {
    const b = file(ts as number[])
    assert.equal(b.episodes.length, 0, what)
    assert.ok(b.issues.some(i => i.level === 'error' && /Map the episode id column/.test(i.message)), what)
  }
  const late = rec(60); [late[20], late[21]] = [late[21], late[20]]
  for (const [ts, what] of [[rec(60), 'plain'], [late, 'one late sample'], [[...rec(30, 3), ...rec(30)], 'parts in the wrong order'], [[...rec(30), ...rec(30, 100)], 'a pause'], [[...rec(30), ...rec(30, 2.5)], 'a clock step back']] as const) {
    const b = file(ts as number[])
    assert.deepEqual(b.episodes.map(e => e.id), ['demo'], what)
    assert.ok(b.issues.some(i => i.level === 'warn' && /one episode named "demo"/.test(i.message)), what)
  }
})

test('camera files without an episode column', () => {
  const file = (rows: [string, number][]) => imp('camera,timestamp\n' + rows.map(r => r.join(',') + '\n').join(''), 'demo.csv')
  const one = (c: string) => [0, 1, 2, 3, 4].map(k => [c, k / 10] as [string, number])
  assert.deepEqual(Object.keys(file([...one('w'), ...one('h')]).cams.demo), ['w', 'h'], 'two cameras, one after the other')
  const b = file([...one('w'), ...one('w')])
  assert.deepEqual(b.cams, {})
  assert.ok(b.issues.some(i => i.level === 'error'))
  // ROS bags are named by their file.
  assert.ok(!imp('topic,stamp,field.position0,field.position1\n' + [0, 1, 2, 3].map(k => `/joint_states,${k / 10},0,0`).join('\n'), 'bag.csv').issues.length)
})
