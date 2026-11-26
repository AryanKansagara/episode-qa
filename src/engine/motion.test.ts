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
