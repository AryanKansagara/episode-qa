import { readFile } from 'node:fs/promises'
import { test as base, expect, type Locator, type Page } from '@playwright/test'

/** The only outside hosts the page asks for: web fonts in index.html. They are answered with an empty stylesheet. */
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com'])

/** `pageErrors` collects uncaught errors, and any error fails the test. `external` lists blocked or stubbed hosts. */
export const test = base.extend<{ external: string[]; pageErrors: string[] }>({
  external: async ({}, use) => { await use([]) },
  pageErrors: async ({}, use) => { await use([]) },
  context: async ({ context, baseURL, external, pageErrors }, use) => {
    const origin = new URL(baseURL!).origin
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin === origin) return route.continue()
      external.push(url.host)
      if (FONT_HOSTS.has(url.host)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' })
      return route.abort('blockedbyclient')
    })
    context.on('weberror', e => pageErrors.push(String(e.error())))
    await use(context)
    expect(pageErrors, 'uncaught page errors').toEqual([])
    expect(external.filter(h => !FONT_HOSTS.has(h)), 'requests to outside hosts').toEqual([])
  },
})

export { expect }

export interface F { name: string; text: string }
export const fixture = async (name: string, as = name): Promise<F> => ({ name: as, text: await readFile(new URL(`../src/engine/fixtures/${name}`, import.meta.url), 'utf8') })

export async function newDataset(page: Page): Promise<string> {
  await page.goto('/app')
  await page.getByRole('button', { name: /^(Import your data|New dataset)$/ }).click()
  await expect(page).toHaveURL(/\/app\/p\/[\w-]+\/data$/)
  await expect(page.getByRole('heading', { name: 'Import', exact: true })).toBeVisible()
  return page.url().replace(/\/data$/, '')
}

export async function openSample(page: Page, tab = 'overview') {
  await page.goto(`/app?sample=1&tab=${tab}`)
  await expect(page.getByRole('heading', { level: 1, name: /pick-and-place|sample/i })).toBeVisible()
  await expect(page).toHaveURL(/\/app\/p\//)
}

export const drop = (page: Page, ...files: (F | { name: string; bytes: Buffer })[]) =>
  page.locator('input[type=file]').setInputFiles(files.map(f => ({ name: f.name, mimeType: 'text/plain', buffer: 'text' in f ? Buffer.from(f.text) : f.bytes })))

export const pending = (page: Page, name: string): Locator => page.locator('.panel').filter({ has: page.getByRole('heading', { name, exact: true }) })

/** Puts a file in the importer and returns its panel, without importing it. */
export async function offer(page: Page, f: F) {
  await drop(page, f)
  const panel = pending(page, f.name)
  await expect(panel.getByText('episodes ready')).toBeVisible()
  return panel
}

export const importButton = (panel: Locator) => panel.getByRole('button', { name: /^Import [\d,]+ episodes$/ })

/** Imports files one by one and waits until each is in the import history and the page shows the stored episodes. */
export async function importFiles(page: Page, ...files: F[]) {
  for (const f of files) {
    const panel = await offer(page, f)
    await importButton(panel).click()
    await expect(panel).toBeHidden()
    const history = page.locator('.panel', { has: page.getByRole('heading', { name: 'Imported data' }) })
    await expect(history.getByRole('rowheader', { name: f.name, exact: true }).first()).toBeVisible()
    await expect.poll(async () => {
      const n = await storedCount(page, page.url().split('/')[5])
      return n !== undefined && (await history.locator('.panel-head').innerText()).includes(`${n.toLocaleString('en-US')} episodes on this device`)
    }).toBe(true)
  }
}

export const TABS = ['Overview', 'Episodes', 'Operators', 'Balance & duplicates', 'Curate & export', 'History', 'Data & limits'] as const
export async function openTab(page: Page, name: (typeof TABS)[number]) {
  const link = page.getByRole('navigation', { name: 'Dataset sections' }).getByRole('link', { name, exact: true })
  await link.click()
  await expect(link).toHaveAttribute('aria-current', 'page')
}

export const kpi = (page: Page, label: string) => page.locator('.kpi', { has: page.getByText(label, { exact: true }) }).locator('b')
export const panelOf = (page: Page, heading: string) => page.locator('.panel', { has: page.getByRole('heading', { name: heading, exact: true }) })

/** The cells of one row that has that row header. */
export async function cells(scope: Page | Locator, rowHeader: string): Promise<string[]> {
  const page = 'page' in scope ? scope.page() : scope
  const r = scope.getByRole('row').filter({ has: page.getByRole('rowheader', { name: rowHeader, exact: true }) }).first()
  await expect(r).toBeVisible()
  return (await r.getByRole('cell').allTextContents()).map(s => s.trim())
}

export async function openEpisode(page: Page, id: string) {
  await openTab(page, 'Episodes')
  await page.getByRole('rowheader', { name: id, exact: true }).getByRole('link').click()
  const panel = page.locator('#ep-detail')
  await expect(panel.locator('h2 .mono')).toHaveText(id)
  return panel
}
export const closeEpisode = async (page: Page) => { await page.getByRole('button', { name: 'Close episode' }).click(); await expect(page.locator('#ep-detail')).toBeHidden() }

export async function downloadText(page: Page, click: () => Promise<void>): Promise<F> {
  const [d] = await Promise.all([page.waitForEvent('download'), click()])
  return { name: d.suggestedFilename(), text: await readFile(await d.path(), 'utf8') }
}

export interface Curated { kept: number; excluded: number; rules: string[]; episodes: { episode_id: string; task: string; tags: string[]; score: number; trim_s: number[] | null; trim_frames: number[] | null }[]; excluded_episodes: { episode_id: string; reasons: string[] }[] }
export async function curatedJson(page: Page): Promise<Curated> {
  await openTab(page, 'Curate & export')
  return JSON.parse((await downloadText(page, () => page.getByRole('button', { name: 'Download JSON' }).click())).text)
}

// ---------- Reading what the app stored (read-only) ----------

type Stored = { projects: { id: string; name: string; versions: unknown[]; rules: unknown[]; stats: { id: string; score: number }[] }[]; data: Record<string, { id: string; t: number[]; q: number[][]; cams: Record<string, number[]> }[]> }
export async function stored(page: Page): Promise<Stored> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('episode-qa')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(['projects', 'data'], 'readonly')
      const projects = tx.objectStore('projects').getAll()
      const data: Record<string, unknown> = {}
      const cur = tx.objectStore('data').openCursor()
      cur.onsuccess = () => { const c = cur.result; if (c) { data[String(c.key)] = c.value; c.continue() } }
      tx.oncomplete = () => { db.close(); resolve({ projects: projects.result, data } as never) }
      tx.onerror = () => reject(tx.error)
    }
  }))
}
/** Number of stored episodes of one dataset, without sending the frames to the test. */
const storedCount = (page: Page, id: string) => page.evaluate(id => new Promise<number | undefined>((resolve, reject) => {
  const open = indexedDB.open('episode-qa')
  open.onerror = () => reject(open.error)
  open.onsuccess = () => {
    const get = open.result.transaction('data', 'readonly').objectStore('data').get(id)
    get.onsuccess = () => { open.result.close(); resolve(get.result?.length) }
    get.onerror = () => reject(get.error)
  }
}), id)
export const storedData = async (page: Page) => (await stored(page)).data

// ---------- Hand-made recordings ----------

export interface Rec { id: string; n?: number; hz?: number; t?: number[]; q0(k: number, t: number): number; task?: string; op?: string; success?: string; grip?(t: number): number; cmd?(t: number): number; skip?: number[] }
/** A frames CSV with joints q0 (as given) and q1 (always 0). */
export function frames(name: string, ...recs: Rec[]): F {
  const lines = ['episode_index,timestamp,q0,q1,gripper,gripper_cmd,task,operator,success']
  for (const r of recs) {
    const t = r.t ?? Array.from({ length: r.n ?? 31 }, (_, k) => k / (r.hz ?? 10))
    t.forEach((x, k) => { if (!r.skip?.includes(k)) lines.push([r.id, x.toFixed(6), r.q0(k, x).toFixed(6), '0', r.grip ? r.grip(x) : '', r.cmd ? r.cmd(x) : '', r.task ?? `task ${r.id}`, r.op ?? 'ana', r.success ?? 'true'].join(',')) })
  }
  return { name, text: lines.join('\n') + '\n' }
}
