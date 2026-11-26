import { cells, curatedJson, downloadText, drop, expect, fixture, frames, importButton, importFiles, kpi, newDataset, offer, openEpisode, openSample, openTab, panelOf, pending, stored, storedData, test } from './fixtures.ts'

const line = (k: number) => 0.1 * k
const current = async (page: import('@playwright/test').Page) => (await storedData(page))[page.url().split('/')[5]]

test('real Koch pandas CSV and episodes.jsonl: degrees to radians, task text attached', async ({ page }) => {
  await newDataset(page)
  const panel = await offer(page, await fixture('koch_pick_place_1_lego.csv'))
  await expect(panel).toContainText('2 episodes ready')
  await expect(panel).toContainText('6 joints')
  await expect(panel).toContainText('read as degrees')
  await importButton(panel).click()
  await expect(panel).toBeHidden()
  const eps = await current(page)
  // First row of the file: 0.791015625, 40.693359375 ... degrees; 40.693359375 x pi / 180 = 0.710233.
  expect(eps[0].q[0][1]).toBeCloseTo(0.710233, 5)
  expect(eps[1].t).toHaveLength(150)
  await importFiles(page, await fixture('koch_pick_place_1_lego.episodes.jsonl'))
  await openTab(page, 'Episodes')
  await expect(page.locator('.ep-table')).toContainText('Pick the lego blocks and place them in the box')
  await expect(page.locator('.ep-table')).not.toContainText('"Pick')
})

test('real ALOHA JSONL: 14 joints in radians at 50 Hz', async ({ page }) => {
  await newDataset(page)
  const panel = await offer(page, await fixture('aloha_sim_insertion_human.jsonl'))
  await expect(panel).toContainText('1 episodes ready · 120 frames · 14 joints · actions')
  await expect(panel).not.toContainText('degrees and converted')
  await importButton(panel).click()
  await openTab(page, 'Overview')
  expect((await cells(page, 'joint_states'))[0]).toBe('50.0 Hz')
})

test('TSV and JSON frames, with a byte order mark, CRLF and a final line without a line break', async ({ page }) => {
  await newDataset(page)
  const csv = frames('a.csv', { id: 'A', q0: line })
  await importFiles(page, { name: 'a.tsv', text: '﻿' + csv.text.trimEnd().replaceAll(',', '\t').replaceAll('\n', '\r\n') })
  await importFiles(page, { name: 'b.json', text: JSON.stringify(Array.from({ length: 31 }, (_, k) => ({ episode_id: 'B', timestamp: k / 10, qpos: [0.1 * k, 0], task: 'json, "quoted"', success: true }))) })
  const eps = await current(page)
  expect(eps.map(e => [e.id, e.t.length, e.q[30][0]])).toEqual([['A', 31, 3], ['B', 31, 3]])
  const j = await curatedJson(page)
  expect(j.episodes.map(e => [e.episode_id, e.task, e.score])).toEqual([['A', 'task A', 100], ['B', 'json, "quoted"', 100]])
})

test('ROS bag CSV: topics become streams, gripper values are held, the file name is the episode', async ({ page }) => {
  await newDataset(page)
  const s0 = 1_700_000_000
  const rows = ['topic,stamp,field.position0,field.position1,field.data']
  // Joints at 10 Hz for 2 s, images at 10 Hz starting 40 ms late: offset +40 ms at both ends.
  for (let k = 0; k <= 20; k++) {
    if (k === 0) rows.push(`/gripper/width,${s0}.000000,,,1`)
    if (k === 10) rows.push(`/gripper/width,${s0 + 1}.000000,,,0.5`)
    rows.push(`/joint_states,${(s0 + k / 10).toFixed(6)},${(0.1 * k).toFixed(3)},0,`)
    rows.push(`/wrist/image_raw,${(s0 + k / 10 + 0.04).toFixed(6)},,,`)
  }
  const panel = await offer(page, { name: 'episode_042.csv', text: rows.join('\n') })
  await expect(panel).toContainText('1 episodes ready · 21 frames · 2 joints')
  await expect(panel).toContainText('cameras: wrist')
  await panel.getByLabel('Gripper value (gripper topic)').selectOption('field.data')
  await importButton(panel).click()
  const ep = await openEpisode(page, 'episode_042')
  await expect(ep).toContainText('wrist is 40 ms off the joint clock (drift 0.0 ms/s)')
  // (40 - 25) / 4 = 3.75
  await expect(ep).toContainText(/Camera sync −3\.[78]/)
  const [e] = await current(page) as unknown as { grip: number[] }[]
  expect([e.grip[9], e.grip[10], e.grip[20]]).toEqual([1, 0.5, 0.5])
})

test('several files dropped at once are ordered frames first, and re-importing an id replaces it', async ({ page }) => {
  await newDataset(page)
  const f = frames('frames.csv', { id: 'A', q0: line }, { id: 'B', q0: line })
  const meta = { name: 'meta.csv', text: 'episode_id,operator,tags\nA,zoe,rig-1;clutter\nnope,zoe,x\n' }
  await drop(page, meta, f)
  await expect(page.locator('.panel h2.break').first()).toHaveText('frames.csv')
  await importButton(pending(page, 'frames.csv')).click()
  await expect(pending(page, 'frames.csv')).toBeHidden()
  await importButton(pending(page, 'meta.csv')).click()
  await expect(page.getByText('1 ids did not match an episode')).toBeVisible()
  await expect(pending(page, 'meta.csv')).toBeHidden()
  await importFiles(page, frames('again.csv', { id: 'A', q0: line, n: 41, op: '' }))
  await openTab(page, 'Episodes')
  const a = await cells(page.locator('.ep-table'), 'A')
  expect([a[1], a[5]]).toEqual(['zoe', '4.0 s'])
  await openTab(page, 'History')
  await expect(page.getByText('Imported again.csv: 0 new, 1 replaced episodes')).toBeVisible()
  expect((await stored(page)).projects[0].versions).toHaveLength(3)
})

test('the sample downloads import again with the same scores', async ({ page }) => {
  test.slow()
  await openSample(page, 'data')
  const f = await downloadText(page, () => page.getByRole('button', { name: 'frames CSV' }).click())
  const c = await downloadText(page, () => page.getByRole('button', { name: 'camera timestamps' }).click())
  const m = await downloadText(page, () => page.getByRole('button', { name: 'episodes.jsonl' }).click())
  const before = (await stored(page)).projects[0].stats
  expect(before).toHaveLength(120)
  await page.goto('/app')
  await page.getByRole('button', { name: 'New dataset' }).click()
  await expect(page.getByRole('heading', { name: 'Import', exact: true })).toBeVisible()
  await importFiles(page, f, c, m)
  const id = page.url().split('/')[5]
  const after = (await stored(page)).projects.find(p => p.id === id)!.stats
  expect(after.map(s => s.id)).toEqual(before.map(s => s.id))
  const off = after.filter((s, i) => Math.abs(s.score - before[i].score) > 1)
  expect(off).toEqual([])
})

test('a file offered on the read-only sample starts a new dataset', async ({ page }) => {
  await openSample(page, 'data')
  const sample = page.url().split('/')[5]
  const panel = await offer(page, frames('mine.csv', { id: 'A', q0: line }))
  await importButton(panel).click()
  await expect(page.getByRole('heading', { level: 1, name: 'My dataset' })).toBeVisible()
  expect(page.url().split('/')[5]).not.toBe(sample)
  const st = await stored(page)
  expect(st.projects.find(p => p.id === sample)!.stats).toHaveLength(120)
  await openTab(page, 'Overview')
  await expect(kpi(page, 'Episodes')).toHaveText('1')
  await expect(panelOf(page, 'Score distribution')).toBeVisible()
})
