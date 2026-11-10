import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeEpisode, balance, defaultConfig, detectGrasps, dtw, dupClusters, jerkSeries, nearDuplicates, operatorFeedback, operatorStats, sliceEpisode, streamStats } from './analyze.ts'
import { curate, decisionsCsv, decisionsJson, diffVersions, makeVersion, matches, type Rule } from './curate.ts'
import { autoMap, build, camerasCsv, detectKind, episodesJsonl, expandArrays, framesCsv, merge, parseCsv, parseJsonl, parseStamp, readTable, resolveCols } from './parse.ts'
import { generateSample, PLANTED_DUPES, SAMPLE_COUNT } from './sample.ts'
import type { Episode, EpisodeStats } from './types.ts'

const HZ = 30
const cfg = defaultConfig()
const grid = (n: number, hz = HZ) => Array.from({ length: n }, (_, k) => k / hz)
const minJerk = (s: number) => s <= 0 ? 0 : s >= 1 ? 1 : 10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5

/** A clean 7-joint episode: still for `lead` s, a smooth 2 s move, still for `trail` s. */
function makeEp(opts: { lead?: number; trail?: number; move?: number; id?: string } = {}): Episode {
  const lead = opts.lead ?? 0.2, trail = opts.trail ?? 0.2, mv = opts.move ?? 2
  const n = Math.round((lead + mv + trail) * HZ) + 1
  const t = grid(n)
  const q = t.map(x => cfg.limits.map(l => (l.min + l.max) / 2 + 0.5 * minJerk((x - lead) / mv)))
  return { id: opts.id ?? 'e1', task: 'pick', operator: 'op', success: true, tags: [], t, q, cams: { wrist: [...t] } }
}
test('sample rate from median period, no drops on a clean stream', () => {
  const s = streamStats('x', grid(301), 1.5)
  assert.ok(Math.abs(s.hz - 30) < 1e-6)
  assert.equal(s.dropped, 0)
})

test('dropped frames counted from timestamp gaps', () => {
  const t = grid(300).filter((_, k) => k < 100 || k >= 105)
  const s = streamStats('x', t, 1.5)
  assert.equal(s.dropped, 5)
  assert.ok(Math.abs(s.dropRate - 5 / 300) < 1e-9)
})

test('timestamp jitter does not count as drops', () => {
  const t = grid(300).map((x, k) => x + (k % 2 ? 0.004 : -0.004))
  assert.equal(streamStats('x', t, 1.5).dropped, 0)
})

test('smooth min-jerk motion has no jerk spikes; a snapped command does', () => {
  const ep = makeEp()
  assert.equal(analyzeEpisode(ep, cfg).jerkEvents, 0)
  const act = ep.q.map(r => [...r])
  for (let k = 20; k < 23; k++) act[k][2] += 0.05
  assert.equal(analyzeEpisode({ ...ep, act }, cfg).jerkEvents, 1, 'one snap is one event')
  for (let k = 40; k < 43; k++) act[k][2] += 0.05
  const s = analyzeEpisode({ ...ep, act }, cfg)
  assert.equal(s.jerkEvents, 2)
  assert.ok(s.issues.some(i => i.kind === 'jerk' && Math.abs(i.t - 40 / HZ) < 0.1))
})

test('jerk windows spanning a dropped gap are ignored', () => {
  const t = grid(60).filter((_, k) => k < 20 || k > 25)
  const x = t.map(v => [v * 0.1])
  const j = jerkSeries(t, x, 1 / HZ, 1.5)
  assert.ok(Number.isNaN(j[20]) && Number.isNaN(j[22]))
  assert.ok(j[30] < 1)
})

test('position saturation within the margin of a limit', () => {
  const ep = makeEp()
  ep.q = ep.q.map((r, k) => r.map((x, j) => j === 3 && k > 30 && k < 60 ? -0.075 : x))
  const s = analyzeEpisode(ep, { ...cfg, th: { ...cfg.th, satMargin: 0.01 } })
  assert.ok(s.satJoints.includes(3))
  assert.ok(s.satFrac > 0.3 && s.satFrac < 0.45)
})

test('velocity saturation against the joint speed limit', () => {
  const ep = makeEp({ move: 0.3 })
  ep.q = ep.q.map(r => r.map((x, j) => j === 0 ? x * 3 : x))
  const s = analyzeEpisode(ep, cfg)
  assert.ok(s.satJoints.includes(0))
  assert.ok(s.issues.some(i => i.kind === 'saturation'))
})

test('leading and trailing idle become a trim range; short idle does not', () => {
  const s = analyzeEpisode(makeEp({ lead: 3, trail: 2.5 }), cfg)
  assert.ok(s.trim[0] > 2.3 && s.trim[0] < 3.1, `start ${s.trim[0]}`)
  assert.ok(s.trim[1] > 5 && s.trim[1] < 5.8, `end ${s.trim[1]}`)
  assert.ok(s.edgeIdleSec > 4.5)
  assert.equal(s.trimFrames[0], Math.round(s.trim[0] * HZ))
  const short = analyzeEpisode(makeEp({ lead: 0.5, trail: 0.5 }), cfg)
  assert.deepEqual(short.trim, [0, short.duration])
})

test('mid-episode pause is flagged as idle, not trimmed', () => {
  const a = makeEp({ lead: 0.2, trail: 0, move: 2 })
  const b = makeEp({ lead: 0, trail: 0.2, move: 2 })
  const pause = grid(61).map(x => x + a.t.at(-1)! + 1 / HZ)
  const t = [...a.t, ...pause, ...b.t.map(x => x + pause.at(-1)! + 1 / HZ)]
  const q = [...a.q, ...pause.map(() => a.q.at(-1)!), ...b.q.map(r => r.map((x, j) => x + a.q.at(-1)![j] - b.q[0][j]))]
  const s = analyzeEpisode({ ...a, t, q, cams: {} }, cfg)
  assert.ok(s.midIdleSec >= 1.9, `mid ${s.midIdleSec}`)
  assert.equal(s.edgeIdleSec, 0)
  assert.ok(s.penalties.idle > 0)
})

function gripEp(target: (k: number) => number, closeAt = 30, openAt = 120, n = 150) {
  const t = grid(n)
  const gripCmd = t.map((_, k) => k >= closeAt && k < openAt ? 1 : 0)
  let g = 1
  const grip = t.map((_, k) => { g += (target(k) - g) * 0.4; return g })
  return { t, grip, gripCmd }
}

test('grasp held when fingers settle on the object and stay', () => {
  const g = detectGrasps(gripEp(k => k >= 30 && k < 120 ? 0.4 : 1), cfg.th)
  assert.equal(g.length, 1)
  assert.equal(g[0].outcome, 'held')
  assert.ok(Math.abs(g[0].t - 1) < 1e-9 && Math.abs(g[0].tOpen - 4) < 1e-9)
})

test('grasp missed when fingers close on nothing', () => {
  const g = detectGrasps(gripEp(k => k >= 30 && k < 120 ? 0 : 1), cfg.th)
  assert.equal(g[0].outcome, 'missed')
})

test('slip: gripper still closed but opening collapses mid-hold', () => {
  const g = detectGrasps(gripEp(k => k >= 30 && k < 80 ? 0.4 : k >= 80 && k < 120 ? 0 : 1), cfg.th)
  assert.equal(g[0].outcome, 'slipped')
  assert.ok(g[0].tFail! > 80 / HZ && g[0].tFail! < 90 / HZ)
})

test('success label contradicted by a failed last grasp is flagged', () => {
  const ep = { ...makeEp({ move: 4 }), ...gripEp(k => k >= 30 && k < 120 ? 0 : 1, 30, 120, makeEp({ move: 4 }).t.length) }
  const s = analyzeEpisode(ep, cfg)
  assert.equal(s.failedGrasps, 1)
  assert.ok(s.issues.some(i => i.kind === 'label'))
  assert.ok(!analyzeEpisode({ ...ep, success: false }, cfg).issues.some(i => i.kind === 'label'))
})

test('camera offset and drift from start and end alignment', () => {
  const ep = makeEp({ move: 8 })
  const dur = ep.t.at(-1)!
  ep.cams = { head: ep.t.map(x => 0.01 + x * 1.01) }
  const c = analyzeEpisode(ep, cfg).cams[0]
  assert.ok(Math.abs(c.offsetMs - 10) < 1e-6)
  assert.ok(Math.abs(c.endOffsetMs - (10 + dur * 10)) < 1e-6)
  assert.ok(Math.abs(c.driftMsPerS - 10) < 1e-6)
  const s = analyzeEpisode(ep, cfg)
  assert.ok(s.issues.some(i => i.kind === 'sync'))
  assert.equal(s.penalties.sync, 15)
})

test('DTW: identical is 0, time-warped copy is near 0, different path is far', () => {
  const a = Array.from({ length: 32 }, (_, i) => [i / 31, Math.sin(i / 5), 0])
  const warped = Array.from({ length: 32 }, (_, i) => { const s = Math.min(31, Math.round(31 * (i / 31) ** 1.3)); return a[s] })
  const b = a.map(p => [p[0], p[1] + 0.3, 0])
  assert.equal(dtw(a, a), 0)
  assert.ok(dtw(a, warped) < 0.06, String(dtw(a, warped)))
  assert.ok(dtw(a, b) > 0.15)
})

test('sample: 120 episodes, 3 operators, 7 joints, 2 cameras, all planted duplicates found and nothing else', () => {
  const eps = generateSample()
  assert.equal(eps.length, SAMPLE_COUNT)
  assert.equal(new Set(eps.map(e => e.operator)).size, 3)
  assert.equal(eps[0].q[0].length, 7)
  assert.deepEqual(Object.keys(eps[0].cams).sort(), ['head', 'wrist'])
  const stats = eps.map(e => analyzeEpisode(e, cfg))
  const pairs = nearDuplicates(stats, cfg.th.dupDist)
  const want = PLANTED_DUPES.map(([a, b]) => `ep_${String(a).padStart(3, '0')}|ep_${String(b).padStart(3, '0')}`).sort()
  assert.deepEqual(pairs.map(p => `${p.a}|${p.b}`).sort(), want)
})

test('sample: planted problems are detected', () => {
  const stats = generateSample().map(e => analyzeEpisode(e, cfg))
  const kinds = new Set(stats.flatMap(s => s.issues.map(i => i.kind)))
  for (const k of ['drop', 'sync', 'jerk', 'saturation', 'idle', 'grasp', 'label']) assert.ok(kinds.has(k as never), k)
  // rig-2's head camera drifts; rig-1 does not
  const rig2 = stats.filter(s => s.tags.includes('rig-2'))
  assert.ok(rig2.every(s => s.issues.some(i => i.kind === 'sync')))
  assert.ok(stats.filter(s => s.tags.includes('rig-1')).every(s => !s.issues.some(i => i.kind === 'sync')))
})

test('duplicate clusters keep the best-scoring member', () => {
  const st = (id: string, score: number) => ({ id, score } as EpisodeStats)
  const stats = [st('a', 70), st('b', 90), st('c', 80), st('d', 50)]
  const cl = dupClusters([{ a: 'a', b: 'b', d: 0 }, { a: 'b', b: 'c', d: 0 }], stats)
  assert.equal(cl.length, 1)
  assert.equal(cl[0].keep, 'b')
  assert.deepEqual(cl[0].drop.sort(), ['a', 'c'])
})

test('operator stats and feedback: the idle operator gets told about idle', () => {
  const stats = generateSample().map(e => analyzeEpisode(e, cfg))
  const ops = operatorStats(stats)
  assert.equal(ops.length, 3)
  assert.equal(ops.reduce((a, o) => a + o.episodes, 0), 120)
  const ben = ops.find(o => o.operator === 'op-ben')!, chen = ops.find(o => o.operator === 'op-chen')!, ana = ops.find(o => o.operator === 'op-ana')!
  assert.ok(ben.edgeIdleFrac > 0.2 && ana.edgeIdleFrac < 0.05)
  assert.ok(chen.failedGraspRate > ana.failedGraspRate)
  assert.ok(operatorFeedback(ben, ops).some(n => /idle at the start or end/.test(n)))
  assert.ok(operatorFeedback(chen, ops).some(n => /grasps missed or slipped/.test(n)))
  assert.deepEqual(operatorFeedback(ana, ops).filter(n => /idle|grasps/.test(n)), [])
})

test('balance flags an under-represented task in the kept set', () => {
  const mk = (id: string, task: string) => ({ id, task, operator: 'x', tags: [], success: true } as unknown as EpisodeStats)
  const stats = [...Array.from({ length: 10 }, (_, i) => mk('a' + i, 'A')), ...Array.from({ length: 9 }, (_, i) => mk('b' + i, 'B')), mk('c0', 'C')]
  const rows = balance(stats, new Set(stats.map(s => s.id)), 'task')
  assert.equal(rows.find(r => r.key === 'C')!.flag, 'under')
  assert.equal(rows.find(r => r.key === 'A')!.flag, null)
})

const S = (over: Partial<EpisodeStats>) => ({ id: 'x', task: 't', operator: 'op', success: true, tags: [], duration: 10, frames: 301, score: 80, dropRate: 0, syncMs: 0, jerkEvents: 0, satFrac: 0, midIdleSec: 0, edgeIdleSec: 0, failedGrasps: 0, issues: [], trim: [0, 10], trimFrames: [0, 300], ...over } as unknown as EpisodeStats)
const R = (field: Rule['field'], op: Rule['op'], value: string, action: Rule['action'] = 'exclude'): Rule => ({ id: field + op + value + action, field, op, value, action, enabled: true })
const noDup = { dupDrop: new Set<string>() }

test('rule matching: numbers, percentages, booleans, tags, text', () => {
  assert.ok(matches(S({ score: 59 }), R('score', '<', '60'), noDup))
  assert.ok(!matches(S({ score: 60 }), R('score', '<', '60'), noDup))
  assert.ok(matches(S({ dropRate: 0.06 }), R('dropRate', '>', '5%'), noDup))
  assert.ok(matches(S({ dropRate: 0.06 }), R('dropRate', '>', '5'), noDup))
  assert.ok(matches(S({ success: false }), R('success', '=', 'false'), noDup))
  assert.ok(!matches(S({ success: null }), R('success', '=', 'false'), noDup))
  assert.ok(matches(S({ tags: ['dim-light'] }), R('tag', '=', 'Dim-Light'), noDup))
  assert.ok(matches(S({ operator: 'op-ben' }), R('operator', '!=', 'op-ana'), noDup))
  assert.ok(matches(S({ id: 'd' }), R('duplicate', '=', 'true'), { dupDrop: new Set(['d']) }))
})

test('curation: keep beats exclude, manual beats rules, trim only on included', () => {
  const stats = [S({ id: 'a', score: 50, operator: 'op-ana', trim: [1, 9] }), S({ id: 'b', score: 50, trim: [1, 9] }), S({ id: 'c', score: 95, trim: [1, 9] }), S({ id: 'd', score: 95 })]
  const rules = [R('score', '<', '60'), R('operator', '=', 'op-ana', 'keep'), R('edgeIdleSec', '<', '100', 'trim')]
  const d = curate(stats, rules, { c: 'exclude' }, noDup)
  assert.deepEqual(d.map(x => x.include), [true, false, false, true])
  assert.deepEqual(d[0].trim, [1, 9])
  assert.equal(d[1].trim, null)
  assert.equal(d[3].trim, null, 'nothing to trim')
  assert.deepEqual(d[2].reasons, ['Manual exclude'])
  const off = curate(stats, rules.map(r => ({ ...r, enabled: false })), {}, noDup)
  assert.ok(off.every(x => x.include && !x.trim))
})

test('curated CSV and JSON exports carry trim ranges and quote safely', () => {
  const stats = [S({ id: 'a', tags: ['x', 'y'], trim: [1.5, 8.25], trimFrames: [45, 247] }), S({ id: 'b, "odd"', score: 10 })]
  const rules = [R('score', '<', '60'), R('edgeIdleSec', '<', '100', 'trim')]
  const d = curate(stats, rules, {}, noDup)
  const lines = decisionsCsv(stats, d).trim().split('\n')
  assert.equal(lines[0].split(',')[5], 'trim_start_s')
  assert.ok(lines[1].startsWith('a,t,op,true,true,1.500,8.250,45,247,80,x;y,'))
  assert.ok(lines[2].startsWith('"b, ""odd""",'))
  const j = decisionsJson(stats, d, rules)
  assert.equal(j.kept, 1)
  assert.deepEqual(j.episodes[0].trim_frames, [45, 247])
  assert.equal(j.excluded_episodes[0].episode_id, 'b, "odd"')
})

test('version diff: episodes added, inclusion changes and rule edits', () => {
  const r1 = R('score', '<', '60'), r2 = R('success', '=', 'false')
  const s1 = [S({ id: 'a', score: 50 }), S({ id: 'b' })]
  const v1 = makeVersion('1', 'v1', 'import', s1, curate(s1, [r1, r2], {}, noDup), [r1, r2])
  const s2 = [...s1, S({ id: 'c' })]
  const r1b = { ...r1, value: '40' }
  const v2 = makeVersion('2', 'v2', 'rules', s2, curate(s2, [r1b], {}, noDup), [r1b])
  const d = diffVersions(v1, v2)
  assert.deepEqual(d.episodesAdded, ['c'])
  assert.deepEqual(d.nowIncluded, ['a'])
  assert.deepEqual(d.rulesRemoved.map(r => r.id), [r2.id])
  assert.equal(d.rulesChanged.length, 1)
  assert.equal(d.rulesChanged[0].after.value, '40')
})

test('timestamps: seconds, ms, us, ns, secs:nsecs and ISO', () => {
  assert.equal(parseStamp('1.5'), 1.5)
  assert.equal(parseStamp('1700000000123'), 1700000000.123)
  assert.equal(parseStamp('1700000000123456'), 1700000000.123456)
  assert.ok(Math.abs(parseStamp('1700000000123456789') - 1700000000.123456789) < 1e-6)
  assert.ok(Math.abs(parseStamp('1700000000:5') - 1700000000.5) < 1e-9)
  assert.equal(parseStamp('2026-11-01T00:00:01Z'), Date.UTC(2026, 10, 1, 0, 0, 1) / 1000)
  assert.ok(Number.isNaN(parseStamp('soon')))
})

test('pandas CSV with array cells expands to columns and auto-maps as LeRobot frames', () => {
  const csv = 'episode_index,frame_index,timestamp,observation.state,action\n0,0,0.0,"[0.1, 0.2, 0.3]","[0.1, 0.2, 0.3]"\n'
  const t = parseCsv(csv)
  assert.deepEqual(t.headers, ['episode_index', 'frame_index', 'timestamp', 'observation.state.0', 'observation.state.1', 'observation.state.2', 'action.0', 'action.1', 'action.2'])
  const m = autoMap(t.headers)
  assert.equal(m.episode, 'episode_index')
  assert.deepEqual(resolveCols(t.headers, m.joints), ['observation.state.0', 'observation.state.1', 'observation.state.2'])
  assert.equal(detectKind(t.headers), 'frames')
  assert.equal(expandArrays(t), t)
})

test('validation reports bad rows with their file line numbers and skips them', () => {
  const csv = 'episode,timestamp,q0,q1\nA,0.0,0,0\nA,0.033,0,0\n\nA,oops,0,0\nA,0.1,abc,0\nA,0.1,0,0\nA,0.066,0,0\nA,0.133,0,0\nA,0.166,0,0\n,0.2,0,0\n'
  const t = parseCsv(csv)
  const b = build(t, 'frames', autoMap(t.headers))
  assert.equal(b.skipped, 3)
  assert.deepEqual(b.issues.filter(i => i.level === 'error').map(i => i.line), [5, 6, 11])
  assert.match(b.issues[0].message, /oops/)
  assert.ok(b.issues.some(i => i.level === 'warn' && /out of order/.test(i.message)))
  assert.equal(b.episodes[0].t.length, 6)
  assert.deepEqual(b.episodes[0].t, [...b.episodes[0].t].sort((x, y) => x - y))
})

test('round trip: sample exported as frames CSV + cameras CSV + episodes JSONL re-imports to the same analysis', () => {
  const src = generateSample().slice(0, 6)
  const frames = readTable('frames.csv', framesCsv(src))
  const fb = build(frames, detectKind(frames.headers), autoMap(frames.headers))
  assert.equal(fb.kind, 'frames')
  assert.equal(fb.issues.filter(i => i.level === 'error').length, 0)
  let ds = merge([], fb).ds
  const cams = readTable('cameras.csv', camerasCsv(src))
  assert.equal(detectKind(cams.headers), 'cameras')
  ds = merge(ds, build(cams, 'cameras', autoMap(cams.headers))).ds
  const meta = readTable('episodes.jsonl', episodesJsonl(src))
  assert.equal(meta.source, 'jsonl')
  assert.equal(detectKind(meta.headers), 'episodes')
  const r = merge(ds, build(meta, 'episodes', autoMap(meta.headers)))
  assert.equal(r.report.metaAttached, 6)
  for (const e of src) {
    const back = r.ds.find(x => x.id === e.id)!
    assert.equal(back.task, e.task)
    assert.equal(back.operator, e.operator)
    assert.deepEqual(back.tags, e.tags)
    const a = analyzeEpisode(e, cfg), b = analyzeEpisode(back, cfg)
    assert.equal(b.score, a.score, e.id)
    assert.equal(b.failedGrasps, a.failedGrasps)
  }
})

test('ROS bag CSV: joint, gripper and camera topics become one episode with held gripper values', () => {
  const rows = ['topic,stamp,field.position0,field.position1,field.data']
  const base = 1700000000
  for (let k = 0; k < 20; k++) {
    const s = base + k / 30
    rows.push(`/arm/joint_states,${s.toFixed(4)},${(k * 0.01).toFixed(3)},0,`)
    rows.push(`/head_camera/image_raw,${(s + 0.02).toFixed(4)},,,`)
    if (k % 5 === 0) rows.push(`/gripper/state,${s.toFixed(4)},,,${k < 10 ? 80 : 20}`)
  }
  const t = parseCsv(rows.join('\n'))
  const m = { ...autoMap(t.headers), grip: 'field.data' }
  assert.equal(detectKind(t.headers), 'ros')
  const b = build(t, 'ros', m, 'bag_0042.csv')
  assert.equal(b.episodes.length, 1)
  const e = b.episodes[0]
  assert.equal(e.id, 'bag_0042')
  assert.equal(e.t.length, 20)
  assert.equal(e.t[0], 0)
  assert.deepEqual(Object.keys(e.cams), ['head_camera'])
  assert.ok(Math.abs(e.cams.head_camera[0] - 0.02) < 1e-4)
  assert.equal(e.grip![0], 1)
  assert.equal(e.grip![12], 0.25)
  assert.ok(b.issues.some(i => /scaled/.test(i.message)))
})

test('JSONL per-frame records with nested arrays flatten to columns', () => {
  const t = parseJsonl('{"episode_index":3,"timestamp":0,"observation":{"state":[1,2]}}\n{"episode_index":3,"timestamp":0.1,"observation":{"state":[1,2.5]}}\nnot json\n')
  assert.deepEqual(t.headers.slice(0, 4), ['episode_index', 'timestamp', 'observation.state.0', 'observation.state.1'])
  const b = build(t, 'frames', autoMap(t.headers))
  assert.equal(b.issues[0].line, 3)
})

test('scrubber prefix: slicing keeps streams consistent and the score only reflects what has happened', () => {
  const ep = generateSample()[19]
  const half = sliceEpisode(ep, 4)
  assert.ok(half.t.at(-1)! <= 4 && half.q.length === half.t.length && half.act!.length === half.t.length)
  assert.ok(Object.values(half.cams).every(c => c.every(x => x <= 4)))
  const full = analyzeEpisode(ep, cfg), early = analyzeEpisode(sliceEpisode(ep, 0.5), cfg)
  assert.ok(early.issues.length < full.issues.length)
})
