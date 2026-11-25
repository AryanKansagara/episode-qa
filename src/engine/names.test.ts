import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeEpisode, defaultConfig } from './analyze.ts'
import { curate, type Override, type Rule } from './curate.ts'
import { autoMap, build, detectKind, merge, readTable } from './parse.ts'
import { derive } from '../projectData.ts'

const imp = (text: string, name = 'f.csv') => { const t = readTable(name, text); const m = autoMap(t.headers); return build(t, detectKind(t.headers, m), m, name) }
const ODD = ['__proto__', 'constructor', 'toString', 'hasOwnProperty']

test('ids and camera names that exist on Object.prototype behave like any other', () => {
  const before = Object.getOwnPropertyNames(Object.prototype)
  for (const id of ODD) {
    const frames = imp('episode_index,timestamp,q0,q1\n' + [0, 1, 2, 3, 4].map(k => `${id},${k / 10},${k / 10},0\n`).join(''))
    const cams = imp('episode_index,camera,timestamp\n' + ODD.flatMap(c => [0, 1, 2].map(k => `${id},${c},${k / 10}\n`)).join(''))
    assert.deepEqual(Object.keys(cams.cams), [id])
    const meta = imp(`episode_index,task,operator,tags\n${id},pick,ana,x;y\n${id},place,,\n`)
    assert.deepEqual(Object.entries(meta.meta), [[id, { task: 'place', operator: 'ana', tags: ['x', 'y'] }]])
    let ds = merge([], frames).ds
    ds = merge(ds, cams).ds
    ds = merge(ds, meta).ds
    assert.deepEqual(Object.entries(ds[0].cams).map(([c, t]) => [c, t.length]), ODD.map(c => [c, 3]))
    assert.deepEqual([ds[0].task, ds[0].operator, ds[0].tags], ['place', 'ana', ['x', 'y']])
    const stats = ds.map(e => analyzeEpisode(e, defaultConfig()))
    const rules: Rule[] = []
    const decide = (o: Record<string, Override>, tags: Record<string, string[]>) => { const d = derive(stats, tags, defaultConfig(), rules, o); return { tags: d.stats[0].tags, ...curate(d.stats, rules, o, d.ctx)[0] } }
    const plain = decide({}, {})
    assert.deepEqual([plain.include, plain.manual, plain.tags], [true, false, ['x', 'y']])
    const set = decide({ ...{}, [id]: 'exclude' }, { [id]: ['z'] })
    assert.deepEqual([set.include, set.manual, set.tags], [false, true, ['z']])
  }
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype), before)
})

test('ROS camera topics and JSONL keys with such names', () => {
  const ros = imp('topic,stamp,field.position0,field.position1\n' + [0, 1, 2, 3].flatMap(k => [`/joint_states,${k / 10},0,0`, `/__proto__/image_raw,${k / 10},,`]).join('\n'), 'bag.csv')
  assert.ok(ros.episodes.length === 1 && Object.keys(ros.episodes[0].cams).length === 1)
  const named = imp('topic,stamp,field.position0,field.position1\n' + [0, 1, 2, 3].flatMap(k => [`/joint_states,${k / 10},0,0`, `constructor/camera,${k / 10},,`, `__proto__/image,${k / 10},,`]).join('\n'), 'bag.csv')
  assert.deepEqual(Object.keys(named.episodes[0].cams), ['constructor/camera', '__proto__'])
  const t = readTable('f.jsonl', '{"episode_index":1,"constructor":"x","__proto__":"y"}\n{"episode_index":2}\n')
  assert.deepEqual(t.headers, ['episode_index', 'constructor', '__proto__'])
  assert.deepEqual(t.rows, [['1', 'x', 'y'], ['2', '', '']])
})
