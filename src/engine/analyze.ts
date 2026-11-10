import type { CamStats, Config, Episode, EpisodeStats, Grasp, Issue, JointLimit, StreamStats, Thresholds } from './types.ts'

export const DEFAULT_TH: Thresholds = {
  dropFactor: 1.5, jerkLimit: 250, idleSpeed: 0.03, idleMinSec: 1.5, settleSec: 0.4,
  emptyGrip: 0.06, satMargin: 0.01, offsetWarnMs: 25, dupDist: 0.006,
}

/** Generic 7-DoF arm limits (rad, rad/s). Users should enter their own robot's datasheet values. */
export const DEFAULT_LIMITS: JointLimit[] = [
  { name: 'j1', min: -2.9, max: 2.9, vel: 2.17 },
  { name: 'j2', min: -1.76, max: 1.76, vel: 2.17 },
  { name: 'j3', min: -2.9, max: 2.9, vel: 2.17 },
  { name: 'j4', min: -3.07, max: -0.07, vel: 2.17 },
  { name: 'j5', min: -2.9, max: 2.9, vel: 2.61 },
  { name: 'j6', min: -0.02, max: 3.75, vel: 2.61 },
  { name: 'j7', min: -2.9, max: 2.9, vel: 2.61 },
]

export const defaultConfig = (): Config => ({ limits: DEFAULT_LIMITS.map(l => ({ ...l })), th: { ...DEFAULT_TH } })

export function median(xs: number[]): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Median sample period and dropped frames from timestamp gaps. */
export function streamStats(name: string, t: number[], factor: number): StreamStats & { gaps: { t: number; missing: number }[]; period: number } {
  const dts: number[] = []
  for (let i = 1; i < t.length; i++) dts.push(t[i] - t[i - 1])
  const period = median(dts)
  const gaps: { t: number; missing: number }[] = []
  let dropped = 0
  if (period > 0) for (let i = 1; i < t.length; i++) {
    const gap = t[i] - t[i - 1]
    if (gap > factor * period) {
      const missing = Math.max(1, Math.round(gap / period) - 1)
      gaps.push({ t: t[i - 1], missing })
      dropped += missing
    }
  }
  const hz = period > 0 ? 1 / period : 0
  return { name, frames: t.length, hz, dropped, dropRate: t.length ? dropped / (t.length + dropped) : 0, gaps, period }
}

/** Groups flagged frames into [start, end] time spans; spans closer than joinGap merge. */
export function spans(t: number[], flag: boolean[], joinGap = 0): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < t.length; i++) {
    if (!flag[i]) continue
    const last = out.at(-1)
    if (last && ((i > 0 && flag[i - 1]) || t[i] - last[1] <= joinGap + 1e-9)) last[1] = t[i]
    else out.push([t[i], t[i]])
  }
  return out
}

/** Per-frame joint velocities (rad/s); frames right after a dropped gap get NaN. */
export function velocities(t: number[], q: number[][], period: number, factor: number): number[][] {
  return q.map((row, k) => {
    if (k === 0) return row.map(() => NaN)
    const dt = t[k] - t[k - 1]
    if (!(dt > 0) || dt > factor * period) return row.map(() => NaN)
    return row.map((x, j) => (x - q[k - 1][j]) / dt)
  })
}

/** Largest third-difference jerk across joints per frame (rad/s^3); NaN where the window spans a gap. */
export function jerkSeries(t: number[], x: number[][], period: number, factor: number): number[] {
  const p3 = period ** 3
  return x.map((row, k) => {
    if (k < 3 || t[k] - t[k - 3] > 3 * factor * period) return NaN
    let m = 0
    for (let j = 0; j < row.length; j++) {
      const v = Math.abs(row[j] - 3 * x[k - 1][j] + 3 * x[k - 2][j] - x[k - 3][j]) / p3
      if (v > m) m = v
    }
    return m
  })
}

/** Close commands become grasps, judged by where the fingers settle and whether they stay there. */
export function detectGrasps(ep: Pick<Episode, 't' | 'grip' | 'gripCmd'>, th: Pick<Thresholds, 'settleSec' | 'emptyGrip'>): Grasp[] {
  const { t, grip, gripCmd } = ep
  const closedAt = (i: number) => gripCmd ? gripCmd[i] >= 0.5 : grip![i] < 0.5
  if (!gripCmd && !grip) return []
  const out: Grasp[] = []
  let i = 1
  while (i < t.length) {
    if (closedAt(i) && !closedAt(i - 1)) {
      let k = i
      while (k < t.length && closedAt(k)) k++
      const tOpen = k < t.length ? t[k] : t[t.length - 1]
      const g: Grasp = { t: t[i], tOpen, outcome: 'unknown' }
      if (grip && gripCmd) {
        const settle = t[i] + th.settleSec
        const s = t.findIndex((x, n) => n >= i && x >= settle)
        if (s === -1 || s >= k) g.outcome = 'unknown'
        else if (grip[s] < th.emptyGrip) { g.outcome = 'missed'; g.tFail = t[s] }
        else {
          const drop = grip.findIndex((x, n) => n > s && n < k && x < th.emptyGrip)
          if (drop !== -1) { g.outcome = 'slipped'; g.tFail = t[drop] } else g.outcome = 'held'
        }
      }
      out.push(g)
      i = k
    } else i++
  }
  return out
}

/** Downsamples a path to n points by time index. */
export function downsample(path: number[][], n = 32): number[][] {
  if (path.length <= n) return path.map(p => [...p])
  return Array.from({ length: n }, (_, i) => path[Math.round(i * (path.length - 1) / (n - 1))])
}

const dist = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return Math.sqrt(s) }

/** Dynamic time warping, normalized by the longer path length (mean step distance). */
export function dtw(a: number[][], b: number[][]): number {
  const n = a.length, m = b.length
  if (!n || !m) return Infinity
  let prev = new Float64Array(m + 1).fill(Infinity)
  prev[0] = 0
  for (let i = 1; i <= n; i++) {
    const cur = new Float64Array(m + 1).fill(Infinity)
    for (let j = 1; j <= m; j++) cur[j] = dist(a[i - 1], b[j - 1]) + Math.min(prev[j], cur[j - 1], prev[j - 1])
    prev = cur
  }
  return prev[m] / Math.max(n, m)
}

export const PENALTY_LABELS: Record<string, string> = { drops: 'Dropped frames', sync: 'Camera sync', jerk: 'Jerky actions', saturation: 'Limit saturation', idle: 'Mid-episode idle', grasp: 'Failed grasps' }

/** Restricts an episode to t <= upTo (used by the live scrubber). */
export function sliceEpisode(ep: Episode, upTo: number): Episode {
  const n = ep.t.findIndex(x => x > upTo)
  if (n === -1) return ep
  const cut = <T,>(a?: T[]) => a?.slice(0, n)
  return { ...ep, t: ep.t.slice(0, n), q: ep.q.slice(0, n), act: cut(ep.act), grip: cut(ep.grip), gripCmd: cut(ep.gripCmd), ee: cut(ep.ee), cams: Object.fromEntries(Object.entries(ep.cams).map(([k, v]) => [k, v.filter(x => x <= upTo)])) }
}

export function analyzeEpisode(ep: Episode, cfg: Config): EpisodeStats {
  const { th, limits } = cfg
  const { t, q } = ep
  const t0 = t[0] ?? 0, tN = t.at(-1) ?? 0
  const duration = tN - t0
  const issues: Issue[] = []

  // Rates and drops
  const js = streamStats('joint_states', t, th.dropFactor)
  for (const g of js.gaps) issues.push({ kind: 'drop', t: g.t, t2: g.t + (g.missing + 1) * js.period, msg: `joint_states: ${g.missing} frame${g.missing > 1 ? 's' : ''} missing` })
  const cams: CamStats[] = Object.entries(ep.cams).map(([name, ct]) => {
    const s = streamStats(name, ct, th.dropFactor)
    for (const g of s.gaps) issues.push({ kind: 'drop', t: g.t, t2: g.t + (g.missing + 1) * s.period, msg: `${name}: ${g.missing} frame${g.missing > 1 ? 's' : ''} missing` })
    // Both recorders start and stop on the same trigger, so the start/end gaps between streams are clock offset; their change over the episode is drift.
    const offsetMs = ct.length ? (ct[0] - t0) * 1000 : 0
    const endOffsetMs = ct.length ? (ct[ct.length - 1] - tN) * 1000 : 0
    const driftMsPerS = duration > 0 ? (endOffsetMs - offsetMs) / duration : 0
    const { gaps: _g, period: _p, ...rest } = s
    return { ...rest, offsetMs, endOffsetMs, driftMsPerS }
  })
  const dropRate = Math.max(js.dropRate, ...cams.map(c => c.dropRate))
  let syncMs = 0
  for (const c of cams) {
    const w = Math.max(Math.abs(c.offsetMs), Math.abs(c.endOffsetMs))
    syncMs = Math.max(syncMs, w)
    if (w > th.offsetWarnMs) issues.push({ kind: 'sync', t: Math.abs(c.endOffsetMs) >= Math.abs(c.offsetMs) ? tN : t0, msg: `${c.name} is ${Math.round(w)} ms off the joint clock (drift ${c.driftMsPerS.toFixed(1)} ms/s)` })
  }

  // Jerk on commanded actions when present
  const jser = jerkSeries(t, ep.act ?? q, js.period, th.dropFactor)
  const jerkSpans = spans(t, jser.map(v => v > th.jerkLimit), 0.2)
  for (const [a, b] of jerkSpans) issues.push({ kind: 'jerk', t: a, t2: b, msg: `Jerk ${Math.round(Math.max(...jser.filter((v, k) => t[k] >= a && t[k] <= b)))} rad/s³` })
  const jerkPeak = jser.reduce((m, v) => v > m ? v : m, 0)

  // Saturation against user-entered limits
  const vel = velocities(t, q, js.period, th.dropFactor)
  const satJ = new Set<number>()
  const satFlag = q.map((row, k) => {
    let hit = false
    for (let j = 0; j < row.length && j < limits.length; j++) {
      const L = limits[j]
      const margin = (L.max - L.min) * th.satMargin
      if (row[j] <= L.min + margin || row[j] >= L.max - margin || Math.abs(vel[k][j]) >= 0.98 * L.vel) { hit = true; satJ.add(j) }
    }
    return hit
  })
  const satFrac = q.length ? satFlag.filter(Boolean).length / q.length : 0
  for (const [a, b] of spans(t, satFlag, 0.1)) issues.push({ kind: 'saturation', t: a, t2: b, msg: `At a joint limit for ${(b - a).toFixed(1)} s` })

  // Idle: fastest joint below idleSpeed, on a 5-frame moving average so sensor noise does not split stretches
  const speed = vel.map(v => v.reduce((m, x) => Math.max(m, Math.abs(x)), 0))
  const idleFlag = speed.map((_, k) => {
    let s = 0, c = 0
    for (let i = Math.max(0, k - 2); i <= Math.min(speed.length - 1, k + 2); i++) if (!Number.isNaN(speed[i])) { s += speed[i]; c++ }
    return c ? s / c < th.idleSpeed : true
  })
  const idle = spans(t, idleFlag).filter(([a, b]) => b - a >= th.idleMinSec)
  let idleSec = 0, edgeIdleSec = 0
  let trimA = t0, trimB = tN
  const pad = 0.25
  for (const [a, b] of idle) {
    idleSec += b - a
    if (a <= t0 + 1e-9) { edgeIdleSec += b - a; trimA = Math.max(t0, b - pad) }
    else if (b >= tN - 1e-9) { edgeIdleSec += b - a; trimB = Math.min(tN, a + pad) }
    else issues.push({ kind: 'idle', t: a, t2: b, msg: `Stationary for ${(b - a).toFixed(1)} s` })
  }
  if (trimA > t0) issues.push({ kind: 'idle', t: t0, t2: trimA, msg: `Leading idle ${(trimA - t0).toFixed(1)} s (trim)` })
  if (trimB < tN) issues.push({ kind: 'idle', t: trimB, t2: tN, msg: `Trailing idle ${(tN - trimB).toFixed(1)} s (trim)` })
  const midIdleSec = idleSec - edgeIdleSec
  const fi = (x: number) => Math.max(0, t.findIndex(v => v >= x - 1e-9))
  const trimFrames: [number, number] = [fi(trimA), trimB >= tN ? t.length - 1 : fi(trimB)]

  // Grasps
  const grasps = detectGrasps(ep, th)
  const failed = grasps.filter(g => g.outcome === 'missed' || g.outcome === 'slipped')
  for (const g of failed) issues.push({ kind: 'grasp', t: g.tFail ?? g.t, msg: g.outcome === 'missed' ? 'Grasp missed: fingers closed on nothing' : 'Object slipped: gripper closed but position not held' })
  const lastJudged = [...grasps].reverse().find(g => g.outcome !== 'unknown')
  if (ep.success === true && lastJudged && lastJudged.outcome !== 'held') issues.push({ kind: 'label', t: lastJudged.tFail ?? lastJudged.t, msg: 'Labelled success, but the last grasp failed' })

  const activeMin = Math.max(duration - edgeIdleSec, 1e-6) / 60
  const penalties: Record<string, number> = {
    drops: Math.min(25, dropRate * 250),
    sync: Math.min(15, Math.max(0, syncMs - th.offsetWarnMs) / 4),
    jerk: Math.min(20, jerkSpans.length * 4),
    saturation: Math.min(15, satFrac * 100),
    idle: Math.min(10, (midIdleSec / 60 / activeMin) * 40),
    grasp: Math.min(20, failed.length * 10),
  }
  const score = Math.max(0, Math.round(100 - Object.values(penalties).reduce((a, b) => a + b, 0)))
  issues.sort((a, b) => a.t - b.t)

  return {
    id: ep.id, task: ep.task, operator: ep.operator, success: ep.success, tags: ep.tags,
    duration, frames: t.length, joints: { name: js.name, frames: js.frames, hz: js.hz, dropped: js.dropped, dropRate: js.dropRate }, cams,
    dropRate, syncMs, jerkEvents: jerkSpans.length, jerkPeak, satFrac, satJoints: [...satJ].sort(), idleSec, midIdleSec, edgeIdleSec,
    trim: [trimA, trimB], trimFrames, grasps, failedGrasps: failed.length, issues, penalties, score,
    path: downsample(ep.ee ?? q.map(r => r.slice(0, 3))).map(p => p.map(x => Math.round(x * 1e4) / 1e4)),
  }
}

// ---------- Dataset level (works on stats alone, so it runs on synced devices without raw frames) ----------

export interface DupPair { a: string; b: string; d: number }

/** Near-duplicate pairs within each task. A cheap endpoint check skips pairs that cannot match. */
export function nearDuplicates(stats: EpisodeStats[], maxDist: number): DupPair[] {
  const out: DupPair[] = []
  for (let i = 0; i < stats.length; i++) for (let k = i + 1; k < stats.length; k++) {
    const A = stats[i], B = stats[k]
    if (A.task !== B.task || !A.path.length || !B.path.length) continue
    if (dist(A.path[0], B.path[0]) > maxDist * 10 || dist(A.path.at(-1)!, B.path.at(-1)!) > maxDist * 10) continue
    const d = dtw(A.path, B.path)
    if (d <= maxDist) out.push({ a: A.id, b: B.id, d })
  }
  return out
}

/** Groups duplicate pairs into clusters; the best-scoring episode in each cluster is the one to keep. */
export function dupClusters(pairs: DupPair[], stats: EpisodeStats[]): { keep: string; drop: string[] }[] {
  const parent = new Map<string, string>()
  const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r }
  for (const { a, b } of pairs) parent.set(find(a), find(b))
  const groups = new Map<string, string[]>()
  for (const id of new Set(pairs.flatMap(p => [p.a, p.b]))) { const r = find(id); groups.set(r, [...(groups.get(r) ?? []), id]) }
  const score = new Map(stats.map(s => [s.id, s.score]))
  const order = new Map(stats.map((s, i) => [s.id, i]))
  return [...groups.values()].map(g => {
    const sorted = [...g].sort((x, y) => (score.get(y)! - score.get(x)!) || order.get(x)! - order.get(y)!)
    return { keep: sorted[0], drop: sorted.slice(1) }
  })
}

export interface OperatorStats {
  operator: string
  episodes: number
  hours: number
  labelled: number
  successRate: number
  meanScore: number
  dropRate: number
  jerkPerMin: number
  idleFrac: number
  edgeIdleFrac: number
  satFrac: number
  grasps: number
  failedGraspRate: number
  labelMismatches: number
}

export function operatorStats(stats: EpisodeStats[]): OperatorStats[] {
  const by = new Map<string, EpisodeStats[]>()
  for (const s of stats) by.set(s.operator, [...(by.get(s.operator) ?? []), s])
  return [...by.entries()].map(([operator, l]) => {
    const dur = l.reduce((a, s) => a + s.duration, 0) || 1e-9
    const labelled = l.filter(s => s.success !== null)
    const grasps = l.reduce((a, s) => a + s.grasps.filter(g => g.outcome !== 'unknown').length, 0)
    const failed = l.reduce((a, s) => a + s.failedGrasps, 0)
    return {
      operator, episodes: l.length, hours: dur / 3600, labelled: labelled.length,
      successRate: labelled.length ? labelled.filter(s => s.success).length / labelled.length : NaN,
      meanScore: l.reduce((a, s) => a + s.score, 0) / l.length,
      dropRate: l.reduce((a, s) => a + s.dropRate, 0) / l.length,
      jerkPerMin: l.reduce((a, s) => a + s.jerkEvents, 0) / (dur / 60),
      idleFrac: l.reduce((a, s) => a + s.idleSec, 0) / dur,
      edgeIdleFrac: l.reduce((a, s) => a + s.edgeIdleSec, 0) / dur,
      satFrac: l.reduce((a, s) => a + s.satFrac * s.duration, 0) / dur,
      grasps, failedGraspRate: grasps ? failed / grasps : 0,
      labelMismatches: l.filter(s => s.issues.some(i => i.kind === 'label')).length,
    }
  }).sort((a, b) => a.operator.localeCompare(b.operator))
}

/** Plain-language coaching notes where an operator is clearly worse than the team median. */
export function operatorFeedback(o: OperatorStats, all: OperatorStats[]): string[] {
  const med = (f: (x: OperatorStats) => number) => median(all.map(f).filter(Number.isFinite))
  const notes: string[] = []
  const pct = (x: number) => `${Math.round(x * 100)}%`
  if (o.edgeIdleFrac > Math.max(0.08, med(x => x.edgeIdleFrac) * 1.5)) notes.push(`${pct(o.edgeIdleFrac)} of recorded time is idle at the start or end of episodes (team median ${pct(med(x => x.edgeIdleFrac))}). Start recording when you are ready to move and stop as soon as the object is placed.`)
  if (o.idleFrac - o.edgeIdleFrac > Math.max(0.05, (med(x => x.idleFrac - x.edgeIdleFrac)) * 1.5)) notes.push(`Long pauses mid-episode (${pct(o.idleFrac - o.edgeIdleFrac)} of time). If you need to re-plan, end the episode and start a new one rather than holding still.`)
  if (o.jerkPerMin > Math.max(0.5, med(x => x.jerkPerMin) * 1.5)) notes.push(`${o.jerkPerMin.toFixed(1)} jerk spikes per minute (team median ${med(x => x.jerkPerMin).toFixed(1)}). Slow down on approach and avoid snapping the controller; abrupt commands teach the policy abrupt motion.`)
  if (o.failedGraspRate > Math.max(0.1, med(x => x.failedGraspRate) * 1.5)) notes.push(`${pct(o.failedGraspRate)} of grasps missed or slipped (team median ${pct(med(x => x.failedGraspRate))}). Pause briefly before closing so the fingers are centred on the object.`)
  if (o.satFrac > Math.max(0.02, med(x => x.satFrac) * 1.5)) notes.push(`At a joint limit ${pct(o.satFrac)} of the time. Re-position the base or approach from a different angle instead of pushing the arm to its limits.`)
  if (o.labelMismatches > 0) notes.push(`${o.labelMismatches} episode${o.labelMismatches > 1 ? 's' : ''} labelled success where the last grasp failed. Check the label before saving.`)
  if (!notes.length) notes.push('No issues above team norms. Keep doing what you are doing.')
  return notes
}

export interface BalanceRow { key: string; episodes: number; kept: number; successes: number; labelled: number; share: number; keptShare: number; flag: 'under' | 'over' | null }

/** Counts per task or tag. Flags groups under half or over double an even share of the kept set. */
export function balance(stats: EpisodeStats[], keep: Set<string>, by: 'task' | 'tag' | 'operator'): BalanceRow[] {
  const groups = new Map<string, EpisodeStats[]>()
  for (const s of stats) {
    const keys = by === 'task' ? [s.task] : by === 'operator' ? [s.operator] : s.tags.length ? s.tags : ['(untagged)']
    for (const k of keys) groups.set(k, [...(groups.get(k) ?? []), s])
  }
  const total = stats.length || 1
  const keptTotal = stats.filter(s => keep.has(s.id)).length || 1
  const even = 1 / (groups.size || 1)
  return [...groups.entries()].map(([key, l]) => {
    const kept = l.filter(s => keep.has(s.id)).length
    const keptShare = kept / keptTotal
    const flag = by === 'tag' ? null : keptShare < even / 2 ? 'under' as const : keptShare > even * 2 ? 'over' as const : null
    return { key, episodes: l.length, kept, successes: l.filter(s => s.success === true).length, labelled: l.filter(s => s.success !== null).length, share: l.length / total, keptShare, flag }
  }).sort((a, b) => b.episodes - a.episodes)
}

/** Histogram of scores in 10-point buckets (0-9 ... 90-100). */
export function scoreHistogram(stats: EpisodeStats[]): number[] {
  const h = new Array(10).fill(0)
  for (const s of stats) h[Math.min(9, Math.floor(s.score / 10))]++
  return h
}
