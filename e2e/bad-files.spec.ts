import { drop, expect, frames, importButton, newDataset, offer, pending, storedData, test } from './fixtures.ts'

const none = async (page: import('@playwright/test').Page) => expect(Object.values(await storedData(page)).flat()).toEqual([])

test('empty, header-only and binary files are refused with a message', async ({ page }) => {
  await newDataset(page)
  for (const [f, msg] of [
    [{ name: 'empty.csv', text: '' }, 'empty.csv has no data rows.'],
    [{ name: 'header.csv', text: 'episode_index,timestamp,q0,q1\n' }, 'header.csv has no data rows.'],
    [{ name: 'empty.jsonl', text: '\n\n' }, 'empty.jsonl has no data rows.'],
    [{ name: 'run.parquet', text: 'PAR1' }, 'run.parquet: binary format.'],
  ] as const) {
    await drop(page, f)
    await expect(page.getByText(msg)).toBeVisible()
    await expect(pending(page, f.name)).toHaveCount(0)
  }
  await none(page)
})

test('a truncated JSON array is refused', async ({ page }) => {
  await newDataset(page)
  await drop(page, { name: 'cut.json', text: '[{"episode_id":"A","timestamp":0,"qpos":[0,0]},{"episode_id":"A","times' })
  await expect(page.getByText(/^cut\.json: /)).toBeVisible()
  await expect(pending(page, 'cut.json')).toHaveCount(0)
})

test('a truncated JSONL keeps complete records and names the cut one', async ({ page }) => {
  await newDataset(page)
  const rec = (k: number) => JSON.stringify({ episode_id: 'A', timestamp: k / 10, qpos: [0.1 * k, 0] })
  const panel = await offer(page, { name: 'cut.jsonl', text: [0, 1, 2, 3, 4].map(rec).join('\n') + '\n' + rec(5).slice(0, 25) })
  await expect(panel).toContainText('1 episodes ready · 5 frames')
  await expect(panel).toContainText('1 rows skipped')
  await expect(panel.getByRole('log')).toContainText('record 6Not valid JSON')
})

test('a wrong file cannot be imported and says what is missing', async ({ page }) => {
  await newDataset(page)
  const panel = await offer(page, { name: 'sales.csv', text: 'region,amount\nwest,12\neast,9\n' })
  await expect(panel).toContainText('0 episodes ready')
  await expect(panel).toContainText('Map the episode id column to attach metadata.')
  await expect(importButton(panel)).toBeDisabled()
  await panel.getByLabel('Format').selectOption('frames')
  await expect(panel).toContainText('Map the timestamp column.')
  await expect(importButton(panel)).toBeDisabled()
  await panel.getByRole('button', { name: 'Cancel' }).click()
  await expect(panel).toBeHidden()
  await none(page)
})

test('bytes that are not text give no episodes', async ({ page }) => {
  await newDataset(page)
  await drop(page, { name: 'noise.csv', bytes: Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 7919 + 13) % 256)) })
  const panel = pending(page, 'noise.csv')
  const refused = page.getByText(/noise\.csv/).first()
  await expect(refused).toBeVisible()
  if (await panel.count()) await expect(importButton(panel)).toBeDisabled()
  await none(page)
})

test('unreadable values are skipped with their line number and the rest is kept', async ({ page }) => {
  await newDataset(page)
  const csv = 'episode_index,timestamp,q0,q1\nA,0.0,0,0\nA,0.1,0.1,0\nA,soon,0.2,0\nA,0.3,abc,0\nA,0.4,,0\n,0.5,0.5,0\nA,0.6,0.6,0\nA,0.7,0.7,0\nB,0.0,0,0\n'
  const panel = await offer(page, { name: 'mixed.csv', text: csv })
  await expect(panel).toContainText('1 episodes ready · 4 frames')
  // Lines 4, 5, 6 and 7 are unreadable; B has one frame, and an episode needs four.
  await expect(panel).toContainText('5 rows skipped')
  const log = panel.getByRole('log')
  await expect(log).toContainText('line 4Timestamp "soon" is not a number or ISO date')
  await expect(log).toContainText('line 5Joint value "abc" in q0 is not a number')
  await expect(log).toContainText('line 6Joint value "" in q0 is not a number')
  await expect(log).toContainText('line 7Missing episode id')
  await expect(log).toContainText('Episode B: only 1 frames, skipped')
})

test('metadata and camera files without episodes are not imported', async ({ page }) => {
  await newDataset(page)
  const panel = await offer(page, { name: 'meta.csv', text: 'episode_id,operator\nA,ana\n' })
  await importButton(panel).click()
  await expect(page.getByText('Nothing to attach yet: import the per-frame table first.')).toBeVisible()
  await none(page)
})

test('markup in names is shown as text', async ({ page }) => {
  await newDataset(page)
  const evil = '<img src=x onerror=alert(1)>'
  page.on('dialog', d => { throw new Error(`dialog: ${d.message()}`) })
  const panel = await offer(page, frames('evil.csv', { id: 'A', q0: k => 0.1 * k, task: evil, op: evil }))
  await importButton(panel).click()
  await expect(panel).toBeHidden()
  for (const t of ['Overview', 'Episodes', 'Operators', 'Curate & export']) {
    await page.getByRole('navigation', { name: 'Dataset sections' }).getByRole('link', { name: t, exact: true }).click()
    await expect(page.locator('img')).toHaveCount(0)
  }
  await page.goto(page.url().replace(/\/curate$/, '/report'))
  await expect(page.getByRole('heading', { name: 'Findings' })).toBeVisible()
  await expect(page.getByText(evil).first()).toBeVisible()
  await expect(page.locator('img')).toHaveCount(0)
})
