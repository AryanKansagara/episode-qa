import { cells, curatedJson, downloadText, expect, frames, importButton, importFiles, newDataset, offer, openEpisode, openTab, pending, drop, storedData, test } from './fixtures.ts'

/* Known bugs, each pinned to its issue with test.fail. The fix turns the pin into a normal test. */

const line = (k: number) => 0.1 * k
const GOOD = 'q0,q1,timestamp,episode_index\n0,0,0.0,a\n0.1,0,0.1,a\n0.2,0,0.2,a\n0.3,0,0.3,a\n'

test('#2 a row cut before the episode column is skipped with its line number', async ({ page }) => {
  await newDataset(page)
  const panel = await offer(page, { name: 'cut.csv', text: GOOD + '0,0' })
  await expect(panel).toContainText('1 episodes ready · 4 frames')
  await expect(panel.getByRole('log')).toContainText('line 6')
})

test('#2 an unclosed quote does not hide the rest of the file', async ({ page }) => {
  await newDataset(page)
  const rows = Array.from({ length: 10 }, (_, i) => `a,${i / 10},${i / 10},0,${i === 4 ? '"pick' : 'pick'}`)
  const panel = await offer(page, { name: 'quote.csv', text: 'episode_index,timestamp,q0,q1,task\n' + rows.join('\n') + '\n' })
  await expect(panel.getByRole('log')).toContainText(/line 6.*quote/i, { timeout: 5000 })
})

// Written by pandas 2.3.3 / numpy 2.2.6 / pyarrow 20 with the command in Docs (read_parquet, then to_csv).
const NUMPY7 = [0, 0.02, 0.04, 0.06].map((t, i) => `"[ 0.27646735  0.6572945   0.26434967 -1.0425258   0.7242847   0.35709965\n -0.4295626 ]","[ 0.46489447  0.29165792  0.235306    0.02273779  0.4373704  -0.58916324\n -0.13032795]",0,${i},${t}`)
test('#3 numpy arrays wrapped over two lines import as joints', async ({ page }) => {
  await newDataset(page)
  const panel = await offer(page, { name: 'numpy.csv', text: 'observation.state,action,episode_index,frame_index,timestamp\n' + NUMPY7.join('\n') + '\n' })
  await expect(panel).toContainText('1 episodes ready · 4 frames · 7 joints · actions', { timeout: 5000 })
  await importButton(panel).click()
  await expect(panel).toBeHidden()
  const [e] = Object.values(await storedData(page))[0]
  expect(e.q[0]).toEqual([0.27646735, 0.6572945, 0.26434967, -1.0425258, 0.7242847, 0.35709965, -0.4295626])
})

test('#4 200,000 frames can be imported', async ({ page }) => {
  test.slow()
  await newDataset(page)
  const text = 'episode_index,timestamp,q0,q1,gripper\n' + Array.from({ length: 200_000 }, (_, i) => `${Math.floor(i / 1000)},${(i % 1000) / 10},0.1,0.2,40`).join('\n')
  await drop(page, { name: 'big.csv', text })
  await expect(pending(page, 'big.csv')).toContainText('200 episodes ready · 200,000 frames')
})

for (const n of [1, 2, 3]) test(`#5 ${n} dropped frame(s) in a constant-speed move are not jerk`, async ({ page }) => {
  await newDataset(page)
  await importFiles(page, frames('drop.csv', { id: 'A', q0: k => k / 30, hz: 30, n: 91, skip: [45, 46, 47].slice(0, n) }))
  const ep = await openEpisode(page, 'A')
  await expect(ep).toContainText(`${n} frame${n > 1 ? 's' : ''} missing`)
  await expect(ep).not.toContainText('Jerk')
})

test('#6 an arm moving through a slower recording is not idle', async ({ page }) => {
  await newDataset(page)
  const t = [...Array.from({ length: 91 }, (_, k) => k / 30), ...Array.from({ length: 30 }, (_, k) => 3 + (k + 1) / 10)]
  await importFiles(page, frames('slow.csv', { id: 'A', t, q0: (_, x) => x }))
  const j = await curatedJson(page)
  expect(j.episodes.map(e => e.trim_s)).toEqual([null])
})

test('#7 blank metadata does not erase a failure label', async ({ page }) => {
  await newDataset(page)
  await importFiles(page, frames('f.csv', { id: 'A', q0: line, success: 'false' }), { name: 'm.csv', text: 'episode_index,operator,success,tags\nA,zoe,,\n' })
  const j = await curatedJson(page)
  expect(j.excluded_episodes.map(e => e.episode_id)).toEqual(['A'])
})

test('#8 relative milliseconds are not read as seconds', async ({ page }) => {
  await newDataset(page)
  await importFiles(page, { name: 'ms.csv', text: 'episode_index,timestamp,q0,q1\n' + Array.from({ length: 31 }, (_, k) => `A,${k * 100},${0.1 * k},0`).join('\n') })
  await openTab(page, 'Overview')
  expect((await cells(page, 'joint_states'))[0]).toBe('10.0 Hz')
})

test('#9 text with a number in it is not a timestamp', async ({ page }) => {
  await newDataset(page)
  const panel = await offer(page, { name: 'names.csv', text: 'episode_index,timestamp,q0,q1\n' + [1, 2, 3, 4, 5].map(k => `A,frame ${k},0,0`).join('\n') })
  await expect(panel).toContainText('0 episodes ready', { timeout: 5000 })
})

test('#10 a drop-rate rule above 1 % matches 9.7 %, and a blank value matches nothing', async ({ page }) => {
  test.fail()
  await newDataset(page)
  await importFiles(page, frames('f.csv', { id: 'A', q0: line, skip: [10, 11, 12] }))
  await openTab(page, 'Curate & export')
  await page.getByRole('button', { name: 'Add rule' }).click()
  await expect(page.locator('.rule')).toHaveCount(6)
  const rule = page.locator('.rule').last()
  await rule.getByLabel('Field').selectOption('dropRate')
  await rule.getByLabel('Operator').selectOption('>')
  await rule.getByLabel('Value').fill('1')
  await rule.getByLabel('Value').press('Enter')
  // Wait until the value is applied: the rule matches while it still says 0.
  await expect(rule.getByRole('button', { name: /^Remove rule: .* is above 1/ })).toBeVisible()
  await expect(rule.locator('.rule-hits')).toHaveText('1 match', { timeout: 5000 })
})

test('#11 excluding the kept copy keeps the other one', async ({ page }) => {
  await newDataset(page)
  await importFiles(page, frames('f.csv', { id: 'A', q0: line, task: 't' }, { id: 'B', q0: line, task: 't' }))
  await (await openEpisode(page, 'A')).getByRole('button', { name: 'Exclude', exact: true }).click()
  await expect(page.locator('#ep-detail')).toContainText('Manual exclude')
  expect((await curatedJson(page)).episodes.map(e => e.episode_id)).toEqual(['B'])
})

test('#12 a task list keeps the whole task', async ({ page }) => {
  test.fail()
  await newDataset(page)
  await importFiles(page, frames('f.csv', { id: '0', q0: line }), { name: 'm.csv', text: "episode_index,tasks\n0,['cube to bin']\n" })
  expect((await curatedJson(page)).episodes[0].task).toBe('cube to bin')
})

test('#13 grasps that could not be judged are not "0% failed"', async ({ page }) => {
  test.fail()
  await newDataset(page)
  await importFiles(page, frames('f.csv', { id: 'A', q0: line, grip: t => t < 1 ? 1 : 0 }))
  await openTab(page, 'Operators')
  // Episodes, Recorded, Score, Success, Failed grasps
  await expect(page.locator('tbody tr').first().getByRole('cell').nth(4)).toHaveText('—', { timeout: 5000 })
})

test('#14 an episode that never moves is not a clean 100', async ({ page }) => {
  test.fail()
  await newDataset(page)
  await importFiles(page, frames('f.csv', { id: 'A', q0: () => 0.5 }))
  await openTab(page, 'Episodes')
  expect((await cells(page.locator('.ep-table'), 'A'))[3]).not.toBe('100')
})

test('#15 trim frames are frame_index values when rows were skipped', async ({ page }) => {
  test.fail()
  await newDataset(page)
  // Moves to k = 40, then still to k = 70. Idle from k = 43 (4.3 s), trim at 4.55 s, so frame 46. Rows 5-24 are unreadable.
  const rows = Array.from({ length: 71 }, (_, k) => `A,${k},${(k / 10).toFixed(1)},${k >= 5 && k < 25 ? 'nan' : (0.1 * Math.min(k, 40)).toFixed(3)},0`)
  await importFiles(page, { name: 'f.csv', text: 'episode_index,frame_index,timestamp,q0,q1\n' + rows.join('\n') })
  // 20 of 71 rows missing costs 25 points: 75, still kept.
  expect((await curatedJson(page)).episodes.map(e => [e.score, e.trim_frames])).toEqual([[75, [0, 46]]])
})

test('#16 a formula in a task name is not written as a formula', async ({ page }) => {
  test.fail()
  await newDataset(page)
  await importFiles(page, frames('f.csv', { id: 'A', q0: line, task: '=1+1' }))
  await openTab(page, 'Curate & export')
  const csv = await downloadText(page, () => page.getByRole('button', { name: 'Download CSV' }).click())
  expect(csv.text.split('\n')[1].split(',')[1]).not.toMatch(/^"?=/)
})

test('#17 recordings without a mapped id column are not merged', async ({ page }) => {
  test.fail()
  await newDataset(page)
  const rows = ['a', 'b'].flatMap(d => [0, 1, 2, 3, 4, 5].map(k => `${d},${k / 10},${k / 10},0`))
  const panel = await offer(page, { name: 'demo.csv', text: 'demo_name,timestamp,q0,q1\n' + rows.join('\n') })
  await expect(importButton(panel)).toBeDisabled({ timeout: 5000 })
})

test('#18 clearing a threshold does not store 0', async ({ page }) => {
  test.fail()
  await newDataset(page)
  await importFiles(page, frames('f.csv', { id: 'A', q0: line }))
  await page.getByLabel(/^Drop gap/).fill('')
  await page.waitForTimeout(1000) // the re-run is stored asynchronously; a score read too early is the old one
  await openTab(page, 'Episodes')
  expect((await cells(page.locator('.ep-table'), 'A'))[3]).toBe('100')
})

test('#19 an episode id of __proto__ does not touch Object.prototype', async ({ page }) => {
  await newDataset(page)
  await offer(page, { name: 'c.csv', text: 'episode_index,camera,timestamp\n__proto__,evil,1\n' })
  expect(await page.evaluate(() => 'evil' in {})).toBe(false)
})

test('#20 secs:nsecs counts nanoseconds', async ({ page }) => {
  test.fail()
  await newDataset(page)
  await importFiles(page, { name: 'f.csv', text: 'episode_index,timestamp,q0,q1\n' + [0, 5_000_000, 10_000_000, 15_000_000, 20_000_000].map((ns, k) => `A,1700000000:${ns},${k / 10},0`).join('\n') })
  await openTab(page, 'Overview')
  expect((await cells(page, 'joint_states'))[0]).toBe('200.0 Hz')
})

test('#21 no jerk limit is suggested when nothing moves', async ({ page }) => {
  test.fail()
  await newDataset(page)
  await importFiles(page, frames('f.csv', { id: 'A', q0: () => 0.5 }))
  await expect(page.getByText('NaN')).toHaveCount(0, { timeout: 5000 })
})
