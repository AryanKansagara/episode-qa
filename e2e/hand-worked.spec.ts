import { closeEpisode, cells, curatedJson, downloadText, expect, frames, importFiles, kpi, newDataset, openEpisode, openTab, panelOf, test, type F } from './fixtures.ts'

/*
 * Eight episodes, two joints, 10 Hz (period 0.1 s), worked out on paper from the rules in Docs.
 * Unless noted an episode is 31 frames, t = 0 ... 3.0 s, q0 = 0.1 k rad (1 rad/s), q1 = 0, labelled success, own task.
 * A straight line has third difference 0, so no jerk; 1 rad/s is never idle; two joints do not fit the default
 * seven limits, so saturation is off until "Use 2 joints".
 *
 * A clean   no penalty                                                                              -> 100
 * B drops   frames 10-12 missing. 28 received, 3 missing: 3/31 = 9.677%. x250 = 24.19              -> 75.81 -> 76
 * C camera  wrist camera from 0.010 s to 3.060 s: +10 ms at the start, +60 ms at the end, drift 50/3 = 16.7 ms/s.
 *           (60 - 25) / 4 = 8.75                                                                    -> 91.25 -> 91
 * D grasp   close command at 1.0 s, opening 0.02 (< 0.06) from 1.1 s; judged at 1.4 s: missed, 10   -> 90
 *           labelled success, last grasp failed: label mismatch, so excluded
 * E idle    moves until k = 20 (2.0 s), then still until 4.0 s (41 frames). The 5-frame mean speed is 0 once
 *           k - 2 >= 21, so from k = 23 (2.3 s): 1.7 s idle at the end (>= 1.5). Trim end 2.3 + 0.25 = 2.55 s,
 *           first frame at or after that: 2.6 s = frame 26. Edge idle is not penalised                  -> 100
 *           The stop itself: velocity 1 -> 0 gives third differences 0.1 / 0.1^3 = 100 rad/s3, below 250.
 * F copy    A with q0 + 0.001, same task as A: mean DTW distance 0.001 <= 0.006. Equal score, so the first (A) stays -> 100
 * G limit   q0 = 0.11 k up to 3.3. With +-3.14 limits the margin is 1% of 6.28, so >= 3.0772: k = 28, 29, 30.
 *           3/31 = 9.68% of frames                                              -> 100, then 90 with "Use 2 joints"
 *           labelled fail, so excluded
 * H jerk    frame 15 is 0.1 rad too far: third differences 0.1, -0.3, 0.3, -0.1 over 0.001 -> 100, 300, 300, 100.
 *           Two neighbouring frames above 250 are one spike: 4                                          -> 96
 *
 * Mean (100+76+91+90+100+100+100+96)/8 = 753/8 = 94.1; with the limits 743/8 = 92.9.
 * Kept: A B C E H. Recorded 7 x 3 + 4 = 25 s; training 3+3+3+2.55+3 = 14.55 s = 58.2%.
 */
const line = (k: number) => 0.1 * k
const HAND: F = frames('hand.csv',
  { id: 'A', q0: line },
  { id: 'B', q0: line, skip: [10, 11, 12], op: 'ben' },
  { id: 'C', q0: line, op: 'ben' },
  { id: 'D', q0: line, op: 'ben', grip: t => t < 1.05 ? 1 : 0.02, cmd: t => t < 0.95 ? 0 : 1 },
  { id: 'E', q0: k => 0.1 * Math.min(k, 20), n: 41 },
  { id: 'F', q0: k => 0.1 * k + 0.001, task: 'task A' },
  { id: 'G', q0: k => 0.11 * k, success: 'false' },
  { id: 'H', q0: k => 0.1 * k + (k === 15 ? 0.1 : 0) },
)
const CAM: F = { name: 'cams.csv', text: 'episode_index,camera,timestamp\n' + Array.from({ length: 31 }, (_, k) => `C,wrist,${(0.01 + k * 3.05 / 30).toFixed(6)}`).join('\n') + '\n' }

test('scores, checks, decisions and exports match the paper results', async ({ page }) => {
  await newDataset(page)
  await importFiles(page, HAND, CAM)
  await openTab(page, 'Episodes')
  const table = page.locator('.ep-table')
  // Episode, task, operator, label, score, issues, length, decision
  const row = async (id: string) => { const c = await cells(table, id); return [c[3], c[5], c[6]] }
  expect(await row('A')).toEqual(['100', '3.0 s', 'Keep'])
  expect(await row('B')).toEqual(['76', '3.0 s', 'Keep'])
  expect(await row('C')).toEqual(['91', '3.0 s', 'Keep'])
  expect(await row('D')).toEqual(['90', '3.0 s', 'Exclude'])
  expect(await row('E')).toEqual(['100', '4.0 s', 'Keep, trim'])
  expect(await row('F')).toEqual(['100', '3.0 s', 'Exclude'])
  expect(await row('G')).toEqual(['100', '3.0 s', 'Exclude'])
  expect(await row('H')).toEqual(['96', '3.0 s', 'Keep'])

  // 8.75 and 1.45 can print either way, depending on the last bit of the stamp arithmetic.
  const detail: Record<string, (string | RegExp)[]> = {
    A: ['No issues', '10.0 Hz', /Penalties\s*None/],
    B: ['joint_states: 3 frames missing', '9.7%', 'Dropped frames −24.2'],
    C: ['wrist is 60 ms off the joint clock (drift 16.7 ms/s)', /Camera sync −8\.[78]/],
    D: ['1.40 s', 'Grasp missed: fingers closed on nothing', 'Labelled success, but the last grasp failed', 'Failed grasps −10.0'],
    E: [/Trailing idle 1\.[45] s \(trim\)/, 'Trim 0.00–2.55 s'],
    H: ['Jerk 300 rad/s³', 'Jerky actions −4.0'],
  }
  for (const [id, texts] of Object.entries(detail)) {
    const panel = await openEpisode(page, id)
    for (const t of texts) await expect(panel).toContainText(t)
    await closeEpisode(page)
  }

  await openTab(page, 'Overview')
  await expect(kpi(page, 'Episodes')).toHaveText('8')
  await expect(kpi(page, 'Mean quality score')).toHaveText('94')
  await expect(kpi(page, 'Kept by current rules')).toHaveText('5')
  await expect(kpi(page, 'Failed grasps')).toHaveText('1')

  const j = await curatedJson(page)
  expect([j.kept, j.excluded]).toEqual([5, 3])
  expect(j.episodes.map(e => [e.episode_id, e.score, e.trim_s, e.trim_frames])).toEqual([
    ['A', 100, null, null], ['B', 76, null, null], ['C', 91, null, null], ['E', 100, [0, 2.55], [0, 26]], ['H', 96, null, null],
  ])
  expect(Object.fromEntries(j.excluded_episodes.map(e => [e.episode_id, e.reasons.length]))).toEqual({ D: 1, F: 1, G: 1 })
  await expect(panelOf(page, 'Curation rules')).toContainText('success label is failure (1)')
  await expect(page.locator('.kpi', { hasText: 'Training time' })).toContainText('58% of recorded')

  const csv = await downloadText(page, () => page.getByRole('button', { name: 'Download CSV' }).click())
  const lines = csv.text.trim().split('\n')
  expect(lines).toHaveLength(9)
  expect(lines.find(l => l.startsWith('E,'))).toBe('E,task E,ana,true,true,0.000,2.550,0,26,100,,')
  expect(lines.find(l => l.startsWith('B,'))).toBe('B,task B,ben,true,true,0.000,3.000,0,27,76,,')
  expect(lines.find(l => l.startsWith('G,'))).toBe('G,task G,ana,false,false,0.000,3.000,0,30,100,,Exclude episodes where success label is failure')

  await openTab(page, 'Balance & duplicates')
  await expect(panelOf(page, 'Near-duplicate episodes')).toContainText(/Keep\s*A.*Duplicate\s*F\s*distance 0\.0010 m/s)

  // ben: B, C, D. Mean (76 + 91 + 90) / 3 = 85.7; one judged grasp, failed.
  await openTab(page, 'Operators')
  const benRow = await page.getByRole('row').filter({ hasText: 'ben' }).getByRole('cell').allInnerTexts()
  expect(benRow.slice(0, 5)).toEqual(['3', '9.0 s', '86', '100%', '100%'])

  // Entering limits for this arm turns saturation on.
  await openTab(page, 'Data & limits')
  await page.getByRole('button', { name: 'Use 2 joints' }).click()
  const g = await openEpisode(page, 'G')
  await expect(g).toContainText('Limit saturation −9.7')
  await expect(g).toContainText('At a joint limit for 0.2 s')
  await openTab(page, 'Overview')
  await expect(kpi(page, 'Mean quality score')).toHaveText('93')
})
