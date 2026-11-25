import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeEpisode, defaultConfig, operatorFeedback, operatorStats, wasChecked } from './analyze.ts'
import type { Episode } from './types.ts'

const t = Array.from({ length: 61 }, (_, k) => k / 30)
const ep = (over: Partial<Episode> = {}): Episode => ({ id: 'a', task: 't', operator: 'o', success: true, tags: [], t, q: t.map(x => [x, 0]), cams: {}, ...over })
const two = { ...defaultConfig(), limits: [1, 2].map(i => ({ name: `j${i}`, min: -9, max: 9, vel: 9 })) }

test('checks that could not run are unknown, not zero', () => {
  const s = analyzeEpisode(ep({ grip: t.map(x => x < 1 ? 1 : 0) }), defaultConfig())
  assert.deepEqual((['drop', 'sync', 'jerk', 'saturation', 'idle', 'grasp', 'label'] as const).map(k => wasChecked(s, k)), [true, false, true, false, true, false, false])
  const [o] = operatorStats([s])
  assert.ok(Number.isNaN(o.failedGraspRate) && Number.isNaN(o.satFrac))
  assert.deepEqual(operatorFeedback(o, [o]), ['No issues above team norms. Keep doing what you are doing.'])
})

test('checks that ran keep their 0, and unchecked episodes do not dilute a rate', () => {
  const cmd = t.map(x => x >= 0.5 && x < 1.5 ? 1 : 0)
  const s = analyzeEpisode(ep({ cams: { w: t }, gripCmd: cmd, grip: cmd.map(c => c ? 0.5 : 1) }), two)
  assert.ok((['sync', 'saturation', 'grasp', 'label'] as const).every(k => wasChecked(s, k)))
  assert.deepEqual([operatorStats([s])[0].failedGraspRate, operatorStats([s])[0].satFrac], [0, 0])
  const at = analyzeEpisode(ep(), { ...two, limits: two.limits.map(l => ({ ...l, vel: 1 })) })
  assert.equal(at.satFrac, 60 / 61)
  const none = analyzeEpisode(ep(), defaultConfig())
  assert.ok(Math.abs(operatorStats([at, none])[0].satFrac - 60 / 61) < 1e-12)
  assert.ok(!wasChecked(analyzeEpisode(ep({ cams: { w: [] } }), two), 'sync'))
  // Results stored before the flag existed read as before.
  assert.ok(wasChecked({ ...none, satChecked: undefined }, 'saturation'))
})

test('feedback still compares operators when one of them has unchecked grasps', () => {
  const cmd = t.map(x => x >= 0.5 && x < 1.5 ? 1 : 0)
  const bad = analyzeEpisode(ep({ operator: 'b', gripCmd: cmd, grip: cmd.map(c => c ? 0 : 1) }), two)
  const ops = operatorStats([analyzeEpisode(ep(), two), bad, analyzeEpisode(ep({ operator: 'c', gripCmd: cmd, grip: cmd.map(c => c ? 0.5 : 1) }), two)])
  assert.match(operatorFeedback(ops[0], ops).join(' '), /100% of grasps missed or slipped \(team median 50%\)/)
})
