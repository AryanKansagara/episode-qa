import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeEpisode, defaultConfig, sliceEpisode } from './analyze.ts'
import { curate, decisionsCsv, type Rule } from './curate.ts'
import { autoMap, build, detectKind, readTable } from './parse.ts'

const imp = (text: string) => { const t = readTable('f.csv', text); const m = autoMap(t.headers); return build(t, detectKind(t.headers, m), m, 'f.csv') }
const TRIM: Rule = { id: 'r', field: 'edgeIdleSec', op: '>', value: '0.5', action: 'trim', enabled: true }
/** Moves until frame 40, then stays still to frame 70. `cell` can change a row, or leave it out. */
const file = (f: (k: number) => number | string, q: (k: number) => string | null = () => null, order = Array.from({ length: 71 }, (_, k) => k)) =>
  imp('episode_index,frame_index,timestamp,q0,q1\n' + order.map(k => `A,${f(k)},${(k / 10).toFixed(1)},${q(k) ?? (0.1 * Math.min(k, 40)).toFixed(3)},0\n`).join(''))
const row = (b: ReturnType<typeof imp>, rules = [TRIM]) => {
  const s = analyzeEpisode(b.episodes[0], defaultConfig())
  const d = curate([s], rules, {}, { dupDrop: new Set() })
  return { trim: d[0].trimFrames, csv: decisionsCsv([s], d).split('\n')[1].split(',').slice(7, 9).map(Number) }
}

test('frame numbers are frame_index values when rows were skipped, repeated or start later', () => {
  const gap = (k: number) => k >= 5 && k < 25 ? 'nan' : null
  assert.deepEqual(row(file(k => k, gap)), { trim: [0, 46], csv: [0, 46] })
  assert.deepEqual(row(file(k => k, gap), []).csv, [0, 70], 'untrimmed')
  assert.deepEqual(row(file(k => k + 100)), { trim: [100, 146], csv: [100, 146] })
  assert.deepEqual(row(file(k => `${k}.0`, k => k < 3 ? 'x' : null)).csv, [3, 46])
  const dup = file(k => k, undefined, [0, 1, 2, 2, 2, ...Array.from({ length: 68 }, (_, i) => i + 3)])
  assert.deepEqual(row(dup).csv, [0, 46])
  const shuffled = file(k => k, undefined, Array.from({ length: 71 }, (_, i) => (i * 30) % 71))
  assert.deepEqual(row(shuffled).csv, [0, 46])
})

test('a frame_index that cannot be used is reported, and rows are counted as before', () => {
  for (const f of [() => 0, (k: number) => k === 8 ? '' : k, (k: number) => 70 - k, (k: number) => k + 0.5, (k: number) => k - 5] as ((k: number) => number | string)[]) {
    const b = file(f)
    assert.deepEqual(row(b).csv, [0, 46])
    assert.equal(b.issues.filter(i => /frame_index does not count up/.test(i.message)).length, 1)
  }
  const none = imp('episode_index,timestamp,q0,q1\n' + [0, 1, 2, 3, 4].map(k => `A,${k / 10},${k},0\n`).join(''))
  assert.ok(!('frame' in none.episodes[0]) && !none.issues.length)
  assert.deepEqual(row(none).csv, [0, 4])
})

test('the scrubber cuts frame numbers with the frames, and results stored before this read as before', () => {
  const e = file(k => k + 100).episodes[0]
  assert.equal(sliceEpisode(e, 2).frame!.at(-1), 120)
  const s = { ...analyzeEpisode(e, defaultConfig()), frameRange: undefined }
  assert.deepEqual(decisionsCsv([s], curate([s], [], {}, { dupDrop: new Set() })).split('\n')[1].split(',').slice(7, 9), ['0', '70'])
})
