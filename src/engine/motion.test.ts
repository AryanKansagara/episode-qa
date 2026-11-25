import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeEpisode, defaultConfig, jerkSeries } from './analyze.ts'
import type { Episode } from './types.ts'

const cfg = { ...defaultConfig(), limits: [] }
const grid = (n: number, hz = 30) => Array.from({ length: n }, (_, k) => k / hz)
const ep = (t: number[], f: (x: number) => number): Episode => ({ id: 'a', task: 't', operator: 'o', success: true, tags: [], t, q: t.map(x => [f(x)]), cams: {} })

test('dropped frames in constant-speed motion are never jerk, wherever they are', () => {
  for (const n of [1, 2, 3]) for (let at = 1; at < 60 - n; at++) {
    const s = analyzeEpisode(ep(grid(60).filter((_, k) => k < at || k >= at + n), x => x), cfg)
    assert.equal(s.jerkEvents, 0, `${n} dropped at ${at}`)
    assert.equal(s.joints.dropped, n)
  }
})

test('a snap next to a drop is still found', () => {
  // Frame 20 is dropped; frame 30 is 0.1 rad off: third differences 0.1, 0.3, 0.3, 0.1 over (1/30)^3.
  const t = grid(60).filter((_, k) => k !== 20)
  const s = analyzeEpisode(ep(t, x => x + (Math.round(x * 30) === 30 ? 0.1 : 0)), cfg)
  assert.equal(s.jerkEvents, 1)
  assert.ok(Math.abs(s.jerkPeak - 0.3 * 27000) < 1)
})

test('without drops only the first three frames have no jerk value', () => {
  const j = jerkSeries(grid(10), grid(10).map(x => [x ** 3]), 1 / 30, 1.5)
  assert.deepEqual(j.map(Number.isNaN), [true, true, true, ...Array(7).fill(false)])
  for (const v of j.slice(3)) assert.ok(Math.abs(v - 6) < 1e-6)
})

test('motion through a slower stretch of the recording is not idle', () => {
  const t = [...grid(91), ...grid(31, 10).slice(1).map(x => x + 3)]
  const s = analyzeEpisode(ep(t, x => x), cfg)
  assert.equal(s.idleSec, 0)
  assert.deepEqual(s.trim, [0, 6])
  assert.ok(s.joints.dropped > 0)
})

test('idle does not run across a gap in which the arm moved, but does when it stayed', () => {
  const t = grid(271).filter((_, k) => k < 90 || k >= 150)
  const moved = analyzeEpisode(ep(t, x => x < 4 ? 0 : 2), cfg)
  // Still until frame 89 (2.967 s); frames 88 and 89 see the 2 rad move in their 5-frame window, so idle ends at 2.9 s.
  assert.ok(Math.abs(moved.trim[0] - (87 / 30 - 0.25)) < 1e-9)
  assert.ok(moved.trim[1] > 5 && moved.trim[1] < 5.5, `trim end ${moved.trim[1]}`)
  const still = analyzeEpisode(ep(t, () => 0), cfg)
  assert.ok(Math.abs(still.idleSec - 9) < 1e-9)
})

test('an arm that never moves is flagged, not clean and not trimmed', () => {
  for (const [f, name] of [[() => 0.5, 'constant'], [(x: number) => 0.5 + 0.0002 * Math.sin(40 * x), 'sensor noise']] as const) {
    const s = analyzeEpisode(ep(grid(91), f), cfg)
    assert.equal(s.score, 60, name)
    assert.deepEqual([s.trim, s.trimFrames, s.edgeIdleSec, s.midIdleSec], [[0, 3], [0, 90], 0, 3], name)
    assert.deepEqual(s.issues.map(i => [i.kind, i.msg]), [['idle', 'The arm never moves (3.0 s)']], name)
  }
  assert.equal(analyzeEpisode(ep(grid(20), () => 0.5), cfg).score, 60, 'constant, shorter than the minimum idle')
})

test('episodes that move are scored and trimmed as before', () => {
  const s = analyzeEpisode(ep(grid(181), x => x < 4 ? 0 : (x - 4) ** 2), cfg)
  assert.equal(s.score, 100)
  assert.ok(s.trim[0] > 3 && s.edgeIdleSec > 3)
  assert.equal(analyzeEpisode(ep(grid(20), x => x * 0.01), cfg).score, 100, 'slow, but shorter than the minimum idle')
  // The viewer's playhead inside a leading idle stretch.
  const part = analyzeEpisode(ep(grid(91), () => 0), cfg, true)
  assert.equal(part.score, 100)
  assert.ok(!part.issues.some(i => /never moves/.test(i.msg)))
})
