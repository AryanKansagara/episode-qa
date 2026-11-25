import type { EpisodeStats } from './types.ts'

export type RuleField = 'score' | 'dropRate' | 'syncMs' | 'jerkEvents' | 'satFrac' | 'midIdleSec' | 'edgeIdleSec' | 'failedGrasps' | 'duration' | 'success' | 'operator' | 'task' | 'tag' | 'duplicate' | 'labelMismatch'
export type RuleOp = '<' | '>' | '=' | '!='
export type RuleAction = 'exclude' | 'keep' | 'trim'

export interface Rule { id: string; field: RuleField; op: RuleOp; value: string; action: RuleAction; enabled: boolean }

export const FIELD_META: Record<RuleField, { label: string; kind: 'num' | 'text' | 'bool'; unit?: string; pct?: boolean }> = {
  score: { label: 'Quality score', kind: 'num' },
  dropRate: { label: 'Dropped-frame rate', kind: 'num', pct: true },
  syncMs: { label: 'Camera offset', kind: 'num', unit: 'ms' },
  jerkEvents: { label: 'Jerk spikes', kind: 'num' },
  satFrac: { label: 'Time at a limit', kind: 'num', pct: true },
  midIdleSec: { label: 'Mid-episode idle', kind: 'num', unit: 's' },
  edgeIdleSec: { label: 'Leading + trailing idle', kind: 'num', unit: 's' },
  failedGrasps: { label: 'Failed grasps', kind: 'num' },
  duration: { label: 'Duration', kind: 'num', unit: 's' },
  success: { label: 'Success label', kind: 'bool' },
  operator: { label: 'Operator', kind: 'text' },
  task: { label: 'Task', kind: 'text' },
  tag: { label: 'Has tag', kind: 'text' },
  duplicate: { label: 'Near-duplicate of a better episode', kind: 'bool' },
  labelMismatch: { label: 'Label contradicts grasp', kind: 'bool' },
}

export const DEFAULT_RULES: Omit<Rule, 'id'>[] = [
  { field: 'success', op: '=', value: 'false', action: 'exclude', enabled: true },
  { field: 'score', op: '<', value: '70', action: 'exclude', enabled: true },
  { field: 'duplicate', op: '=', value: 'true', action: 'exclude', enabled: true },
  { field: 'labelMismatch', op: '=', value: 'true', action: 'exclude', enabled: true },
  { field: 'edgeIdleSec', op: '>', value: '0.5', action: 'trim', enabled: true },
]

export interface Ctx { dupDrop: Set<string> }

function value(s: EpisodeStats, f: RuleField, ctx: Ctx): number | string | boolean | null | string[] {
  switch (f) {
    case 'success': return s.success
    case 'operator': return s.operator
    case 'task': return s.task
    case 'tag': return s.tags
    case 'duplicate': return ctx.dupDrop.has(s.id)
    case 'labelMismatch': return s.issues.some(i => i.kind === 'label')
    default: return s[f]
  }
}

const parseBool = (v: string) => /^(true|yes|1|success)$/i.test(v.trim())
const pctOrNum = (f: RuleField, v: string) => { const n = Number(v.replace('%', '')); return FIELD_META[f].pct && (v.includes('%') || n > 1) ? n / 100 : n }

export function matches(s: EpisodeStats, r: Rule, ctx: Ctx): boolean {
  const v = value(s, r.field, ctx)
  const meta = FIELD_META[r.field]
  if (r.field === 'tag') {
    const has = (v as string[]).some(t => t.toLowerCase() === r.value.trim().toLowerCase())
    return r.op === '!=' ? !has : has
  }
  if (meta.kind === 'bool') {
    if (v === null) return false
    const eq = v === parseBool(r.value)
    return r.op === '!=' ? !eq : eq
  }
  if (meta.kind === 'text') {
    const eq = String(v).toLowerCase() === r.value.trim().toLowerCase()
    return r.op === '!=' ? !eq : r.op === '=' ? eq : false
  }
  const n = v as number, x = pctOrNum(r.field, r.value)
  if (!Number.isFinite(x)) return false
  return r.op === '<' ? n < x : r.op === '>' ? n > x : r.op === '=' ? Math.abs(n - x) < 1e-9 : Math.abs(n - x) >= 1e-9
}

export function describeRule(r: Rule): string {
  const m = FIELD_META[r.field]
  const verb = r.action === 'exclude' ? 'Exclude' : r.action === 'keep' ? 'Always keep' : 'Trim idle edges of'
  if (m.kind === 'bool') return `${verb} episodes where ${m.label.toLowerCase()} ${r.op === '!=' ? 'is not' : 'is'} ${parseBool(r.value) ? (r.field === 'success' ? 'success' : 'true') : (r.field === 'success' ? 'failure' : 'false')}`
  const op = { '<': 'below', '>': 'above', '=': 'equal to', '!=': 'not' }[r.op]
  return `${verb} episodes where ${m.label.toLowerCase()} is ${op} ${r.value}${m.unit ? ' ' + m.unit : ''}`
}

export type Override = 'keep' | 'exclude'
export interface Decision { id: string; include: boolean; reasons: string[]; trim: [number, number] | null; trimFrames: [number, number] | null; manual: boolean }

/**
 * Applies rules then manual overrides. A matching keep rule beats any exclude rule;
 * a manual override beats both. Trim only applies to included episodes.
 */
export function curate(stats: EpisodeStats[], rules: Rule[], overrides: Record<string, Override>, ctx: Ctx): Decision[] {
  return stats.map(s => {
    const hit = rules.filter(r => r.enabled && matches(s, r, ctx))
    const ex = hit.filter(r => r.action === 'exclude')
    const keep = hit.some(r => r.action === 'keep')
    const trimRule = hit.some(r => r.action === 'trim')
    const o = overrides[s.id]
    const include = o ? o === 'keep' : keep || !ex.length
    const reasons = o ? [`Manual ${o}`] : keep && ex.length ? ['Kept by rule'] : ex.map(describeRule)
    const trim = include && trimRule && (s.trim[0] > 0 || s.trim[1] < s.duration) ? s.trim : null
    return { id: s.id, include, reasons, trim, trimFrames: trim ? s.trimFrames : null, manual: !!o }
  })
}

const csvCell = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

export function decisionsCsv(stats: EpisodeStats[], ds: Decision[]): string {
  const by = new Map(stats.map(s => [s.id, s]))
  const head = ['episode_id', 'task', 'operator', 'success', 'include', 'trim_start_s', 'trim_end_s', 'trim_start_frame', 'trim_end_frame', 'score', 'tags', 'reasons']
  const rows = ds.map(d => {
    const s = by.get(d.id)!
    const [a, b] = d.trim ?? [0, s.duration]
    const [fa, fb] = d.trimFrames ?? [0, s.frames - 1]
    return [d.id, s.task, s.operator, s.success ?? '', d.include, a.toFixed(3), b.toFixed(3), fa, fb, s.score, s.tags.join(';'), d.reasons.join('; ')].map(csvCell).join(',')
  })
  return [head.join(','), ...rows].join('\n') + '\n'
}

export function decisionsJson(stats: EpisodeStats[], ds: Decision[], rules: Rule[]) {
  const by = new Map(stats.map(s => [s.id, s]))
  return {
    generated_at: new Date().toISOString(),
    rules: rules.filter(r => r.enabled).map(describeRule),
    kept: ds.filter(d => d.include).length,
    excluded: ds.filter(d => !d.include).length,
    episodes: ds.filter(d => d.include).map(d => {
      const s = by.get(d.id)!
      return { episode_id: d.id, task: s.task, operator: s.operator, tags: s.tags, score: s.score, trim_s: d.trim ? d.trim.map(x => +x.toFixed(3)) : null, trim_frames: d.trimFrames }
    }),
    excluded_episodes: ds.filter(d => !d.include).map(d => ({ episode_id: d.id, reasons: d.reasons })),
  }
}

// ---------- Versions ----------

export interface Version {
  id: string
  label: string
  at: number
  kind: 'import' | 'manual' | 'rules'
  episodes: number
  hours: number
  kept: number
  meanScore: number
  included: string[]
  all: string[]
  rules: Rule[]
  issueCounts: Record<string, number>
}

export function makeVersion(id: string, label: string, kind: Version['kind'], stats: EpisodeStats[], ds: Decision[], rules: Rule[], at = Date.now()): Version {
  const issueCounts: Record<string, number> = {}
  for (const s of stats) for (const i of s.issues) issueCounts[i.kind] = (issueCounts[i.kind] ?? 0) + 1
  return {
    id, label, at, kind, episodes: stats.length, hours: stats.reduce((a, s) => a + s.duration, 0) / 3600,
    kept: ds.filter(d => d.include).length, meanScore: stats.length ? stats.reduce((a, s) => a + s.score, 0) / stats.length : 0,
    included: ds.filter(d => d.include).map(d => d.id), all: stats.map(s => s.id), rules: rules.map(r => ({ ...r })), issueCounts,
  }
}

export interface VersionDiff {
  episodesAdded: string[]
  episodesRemoved: string[]
  nowIncluded: string[]
  nowExcluded: string[]
  rulesAdded: Rule[]
  rulesRemoved: Rule[]
  rulesChanged: { before: Rule; after: Rule }[]
}

export function diffVersions(a: Version, b: Version): VersionDiff {
  const aAll = new Set(a.all), bAll = new Set(b.all), aIn = new Set(a.included), bIn = new Set(b.included)
  const ra = new Map(a.rules.map(r => [r.id, r])), rb = new Map(b.rules.map(r => [r.id, r]))
  const same = (x: Rule, y: Rule) => x.field === y.field && x.op === y.op && x.value === y.value && x.action === y.action && x.enabled === y.enabled
  return {
    episodesAdded: b.all.filter(id => !aAll.has(id)),
    episodesRemoved: a.all.filter(id => !bAll.has(id)),
    nowIncluded: b.included.filter(id => !aIn.has(id) && aAll.has(id)),
    nowExcluded: a.included.filter(id => !bIn.has(id) && bAll.has(id)),
    rulesAdded: b.rules.filter(r => !ra.has(r.id)),
    rulesRemoved: a.rules.filter(r => !rb.has(r.id)),
    rulesChanged: b.rules.filter(r => ra.has(r.id) && !same(ra.get(r.id)!, r)).map(r => ({ before: ra.get(r.id)!, after: r })),
  }
}
