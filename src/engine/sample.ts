// Synthetic pick-and-place teleop dataset: 120 episodes, 3 operators, a 7-DoF arm with a gripper and 2 cameras.
// Every value is generated; problems are planted on purpose so the QA engine has something to find.
import type { Episode } from './types.ts'

export const SAMPLE_ID = 'pick-place-v1'
export const SAMPLE_NAME = 'Pick-and-place teleop, week 44 (synthetic)'
export const SAMPLE_COUNT = 120
const HZ = 30
const OPS = ['op-ana', 'op-ben', 'op-chen']
const TASKS = [
  { name: 'cube to bin', pick: [0.55, -0.15], place: [0.35, 0.3], width: 0.42 },
  { name: 'cylinder to shelf', pick: [0.6, 0.05], place: [0.45, -0.32], width: 0.33 },
  { name: 'sphere to tray', pick: [0.5, 0.2], place: [0.62, -0.1], width: 0.5 },
]
/** Episodes that are re-exports of an earlier one (source index -> duplicate index). */
export const PLANTED_DUPES: [number, number][] = [[4, 37], [12, 58], [21, 90], [30, 111]]

function rng(seed: number) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r())
const minJerk = (s: number) => s <= 0 ? 0 : s >= 1 ? 1 : 10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5

// Fixed made-up linear-plus-wobble map from end-effector position to 7 joint angles (not a real arm's kinematics).
const A = [[1.2, -0.8, 0.3], [0.9, 0.2, -1.4], [-0.4, 1.1, 0.5], [1.3, 0.1, 1.6], [-0.2, 0.9, -0.6], [0.7, -0.3, -1.2], [0.4, 1.4, 0.2]]
const B = [-0.6, 0.1, -0.2, -2.4, 0.05, 2.3, 0.2]
const toJoints = (p: number[]) => A.map((a, j) => a[0] * p[0] + a[1] * p[1] + a[2] * p[2] + B[j] + 0.08 * Math.sin(3 * p[0] + j))

interface Seg { to: number[]; dur: number; cmd: number; grip?: number; gripAt?: number }

/** Plan for one episode: kind of planted problems and the motion segments. */
export function plan(i: number) {
  const r = rng(1000 + i)
  const op = OPS[i % 3]
  const u = r()
  const taskIx = u < 0.55 ? 0 : u < 0.85 ? 1 : 2
  const task = TASKS[taskIx]
  const tags: string[] = []
  const rig = i % 4 === 3 ? 'rig-2' : 'rig-1'
  tags.push(rig)
  if (r() < 0.2) tags.push('dim-light')
  if (r() < 0.25) tags.push('clutter')
  const ben = op === 'op-ben', chen = op === 'op-chen'
  const pick = [task.pick[0] + (r() - 0.5) * 0.16, task.pick[1] + (r() - 0.5) * 0.16, 0.03]
  const place = [task.place[0] + (r() - 0.5) * 0.16, task.place[1] + (r() - 0.5) * 0.16, 0.06]
  const home = [0.45, 0, 0.42]
  const lead = ben ? 1.6 + r() * 2.2 : 0.15 + r() * 0.4
  const trail = ben ? 1.4 + r() * 1.8 : 0.15 + r() * 0.4
  const fate = r()
  const missed = chen ? fate < 0.2 : fate < 0.03
  const slipped = !missed && (chen ? fate < 0.32 : fate < 0.05)
  const retrySucceeds = r() < 0.6
  const midPause = ben && r() < 0.3 ? 1.6 + r() * 1.4 : 0
  const jerky = ben ? r() < 0.4 : r() < 0.04
  const saturate = r() < 0.05 || i === 7 || i === 66
  const camDrops = r() < 0.1 || i === 2
  const jointDrops = r() < 0.035
  const mislabel = slipped && r() < 0.5

  const above = (p: number[]) => [p[0], p[1], p[2] + 0.13]
  const segs: Seg[] = [{ to: home, dur: lead, cmd: 0 }, { to: above(pick), dur: 1.3 + r() * 0.5, cmd: 0 }, { to: pick, dur: 0.75 + r() * 0.25, cmd: 0 }]
  let success = true
  if (missed) {
    segs.push({ to: pick, dur: 0.6, cmd: 1, grip: 0 }, { to: pick, dur: 0.35, cmd: 0, grip: 1 }, { to: above(pick).map((x, k) => k === 2 ? x - 0.07 : x), dur: 0.5, cmd: 0 }, { to: pick, dur: 0.55, cmd: 0 })
    if (!retrySucceeds) { segs.push({ to: pick, dur: 0.6, cmd: 1, grip: 0 }, { to: pick, dur: 0.3, cmd: 0, grip: 1 }, { to: home, dur: 1.4, cmd: 0 }, { to: home, dur: trail, cmd: 0 }); success = false }
  }
  if (success) {
    segs.push({ to: pick, dur: 0.5, cmd: 1, grip: task.width }, { to: above(pick), dur: 0.8, cmd: 1 })
    if (midPause) segs.push({ to: above(pick), dur: midPause, cmd: 1 })
    segs.push({ to: above(place), dur: 1.5 + r() * 0.7, cmd: 1, ...(slipped ? { grip: 0, gripAt: 0.45 } : {}) })
    if (slipped) { segs.push({ to: above(place), dur: 0.5, cmd: 0, grip: 1 }, { to: home, dur: 1.3, cmd: 0 }, { to: home, dur: trail, cmd: 0 }); success = false }
    else segs.push({ to: place, dur: 0.7, cmd: 1 }, { to: place, dur: 0.4, cmd: 0, grip: 1 }, { to: above(place), dur: 0.5, cmd: 0 }, { to: home, dur: 1.2 + r() * 0.3, cmd: 0 }, { to: home, dur: trail, cmd: 0 })
  }
  return { r, op, task: task.name, tags, rig, segs, success: mislabel ? true : success, jerky, saturate, camDrops, jointDrops, slipped }
}

export function generateEpisode(i: number): Episode {
  const dupOf = PLANTED_DUPES.find(d => d[1] === i)
  if (dupOf) {
    const src = generateEpisode(dupOf[0])
    const r = rng(9000 + i)
    const n = () => gauss(r) * 0.0004
    return { ...src, id: `ep_${String(i).padStart(3, '0')}`, ee: src.ee!.map(p => p.map(x => x + n())), q: src.q.map(row => row.map(x => x + n())) }
  }
  const p = plan(i)
  const { r } = p
  const total = p.segs.reduce((a, s) => a + s.dur, 0)
  const n = Math.floor(total * HZ) + 1
  const t: number[] = [], ee: number[][] = [], cmd: number[] = [], gripTarget: number[] = []
  let si = 0, segStart = 0, from = p.segs[0].to, gT = 1
  // The first segment starts at home: the arm is idle while the operator settles in.
  for (let k = 0; k < n; k++) {
    const tt = k / HZ
    while (si < p.segs.length - 1 && tt > segStart + p.segs[si].dur) { from = p.segs[si].to; segStart += p.segs[si].dur; si++ }
    const s = p.segs[si]
    if (s.grip !== undefined && tt >= segStart + s.dur * (s.gripAt ?? 0)) gT = s.grip
    const f = minJerk((tt - segStart) / s.dur)
    ee.push(from.map((x, d) => x + (s.to[d] - x) * f))
    t.push(tt + gauss(r) * 0.0006)
    cmd.push(s.cmd)
    gripTarget.push(gT)
  }
  // Gripper opening follows its target with a first-order lag.
  const grip: number[] = []
  let g = 1
  for (let k = 0; k < n; k++) { g += (gripTarget[k] - g) * (1 - Math.exp(-1 / HZ / 0.07)); grip.push(Math.max(0, Math.min(1, g + gauss(r) * 0.003))) }

  const lead = 0.05
  const act = ee.map((_, k) => toJoints(ee[Math.min(n - 1, k + Math.round(lead * HZ))]).map(x => x + gauss(r) * 0.00002))
  let q = ee.map(pp => toJoints(pp).map(x => x + gauss(r) * 0.0001))
  if (p.saturate) {
    // Operator pushes joint 4 into its upper limit during transport; the controller clamps.
    const ts = t[Math.floor(n * 0.45)], te = ts + 1.3
    const bump = (x: number) => x < ts ? 0 : x > te ? 1 : minJerk((x - ts) / 1.3)
    q = q.map((row, k) => row.map((x, j) => j === 3 ? Math.min(-0.071, x + 2.1 * bump((k / HZ)) * ((k / HZ) < te + 1.2 ? 1 : 1 - minJerk(((k / HZ) - te - 1.2) / 1.0))) : x))
    act.forEach((row, k) => { row[3] += 2.1 * bump((k / HZ)) * ((k / HZ) < te + 1.2 ? 1 : 1 - minJerk(((k / HZ) - te - 1.2) / 1.0)) })
  }
  if (p.jerky) {
    // Snapped controller: short steps in the commanded position.
    const spikes = 2 + Math.floor(r() * 3)
    for (let s = 0; s < spikes; s++) {
      const k0 = Math.floor(n * (0.2 + r() * 0.6)), j = Math.floor(r() * 7), amp = (0.03 + r() * 0.04) * (r() < 0.5 ? -1 : 1)
      for (let k = k0; k < Math.min(n, k0 + 3); k++) act[k][j] += amp
    }
  }

  // Cameras: wrist at 30 Hz, head at 30 Hz. rig-2's head camera clock runs fast.
  const camTimes = (offset: number, drift: number) => Array.from({ length: Math.floor(total * HZ) + 1 }, (_, k) => offset + (k / HZ) * (1 + drift) + gauss(r) * 0.0008)
  const wrist = camTimes(gauss(r) * 0.003, 0)
  const head = p.rig === 'rig-2' ? camTimes(0.012 + r() * 0.01, 0.008 + r() * 0.004) : camTimes(gauss(r) * 0.003, 0)
  const cut = (arr: number[], bursts: number, min: number, max: number) => {
    let out = arr
    for (let b = 0; b < bursts; b++) { const len = min + Math.floor(r() * (max - min)), at = Math.floor(out.length * (0.1 + r() * 0.8)); out = [...out.slice(0, at), ...out.slice(at + len)] }
    return out
  }
  const wristFinal = p.camDrops ? cut(wrist, 1 + Math.floor(r() * 3), 4, 16) : wrist
  let keep = t.map(() => true)
  if (p.jointDrops) { const at = Math.floor(n * (0.3 + r() * 0.4)); for (let k = at; k < at + 3 + Math.floor(r() * 6); k++) keep[k] = false }
  const sel = <T,>(a: T[]) => a.filter((_, k) => keep[k])
  const t0 = t[0]
  return {
    id: `ep_${String(i).padStart(3, '0')}`, task: p.task, operator: p.op, success: p.success, tags: p.tags,
    t: sel(t).map(x => +(x - t0).toFixed(4)), q: sel(q), act: sel(act), grip: sel(grip), gripCmd: sel(cmd), ee: sel(ee),
    cams: { wrist: wristFinal.map(x => +(x - t0).toFixed(4)), head: head.map(x => +(x - t0).toFixed(4)) },
  }
}

let cache: Episode[] | null = null
export function generateSample(): Episode[] {
  return cache ??= Array.from({ length: SAMPLE_COUNT }, (_, i) => generateEpisode(i))
}

/** The episode the landing-page hero plays: an op-ben episode with idle, jerk, a drop and camera drift. */
export const HERO_EPISODE = 19
