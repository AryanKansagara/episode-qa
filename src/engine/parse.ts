import type { Episode } from './types.ts'

export interface Table { headers: string[]; rows: string[][]; lines: number[]; source: 'csv' | 'jsonl' }
export type Kind = 'frames' | 'cameras' | 'episodes' | 'ros'
export const KINDS: Record<Kind, string> = {
  frames: 'Per-frame table (CSV / JSONL, LeRobot export)',
  cameras: 'Camera frame timestamps',
  episodes: 'Episode metadata (LeRobot episodes.jsonl or CSV)',
  ros: 'ROS bag CSV export (topic, stamp, fields)',
}

// ---------- Reading ----------

export function parseCsv(text: string): Table {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const nl = text.indexOf('\n')
  const head = text.slice(0, nl === -1 ? text.length : nl)
  const delim = [',', '\t', ';'].map(d => [d, head.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0]
  const rows: string[][] = [], lines: number[] = []
  let row: string[] = [], field = '', quoted = false, line = 1, rowLine = 1
  const endRow = () => { row.push(field); field = ''; if (row.length > 1 || row[0] !== '') { rows.push(row); lines.push(rowLine) } row = [] }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false }
      else { if (c === '\n') line++; field += c }
    } else if (c === '"' && field === '') quoted = true
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; endRow(); line++; rowLine = line }
    else field += c
  }
  if (field !== '' || row.length) endRow()
  const [headers = [], ...body] = rows
  return expandArrays({ headers: headers.map(h => h.trim()), rows: body, lines: lines.slice(1), source: 'csv' })
}

function flatten(o: unknown, prefix: string, out: Record<string, string>) {
  if (Array.isArray(o)) {
    if (o.every(x => typeof x !== 'object' || x === null)) { o.forEach((x, i) => { out[`${prefix}.${i}`] = x === null ? '' : String(x) }); if (!o.length) out[prefix] = ''; return }
    o.forEach((x, i) => flatten(x, `${prefix}.${i}`, out))
  } else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) flatten(v, prefix ? `${prefix}.${k}` : k, out)
  else out[prefix] = o === null || o === undefined ? '' : String(o)
}

/** JSONL, or a JSON array of records. Nested objects and arrays flatten to dotted columns (observation.state.0 ...). */
export function parseJsonl(text: string): Table {
  const recs: { r: Record<string, string>; line: number }[] = []
  const t = text.trim()
  if (t.startsWith('[')) {
    const arr = JSON.parse(t) as unknown[]
    arr.forEach((o, i) => { const r: Record<string, string> = {}; flatten(o, '', r); recs.push({ r, line: i + 1 }) })
  } else {
    text.split(/\r?\n/).forEach((l, i) => {
      if (!l.trim()) return
      const r: Record<string, string> = {}
      try { flatten(JSON.parse(l), '', r) } catch { r['__error'] = 'Not valid JSON' }
      recs.push({ r, line: i + 1 })
    })
  }
  const headers: string[] = []
  const seen = new Set<string>()
  for (const { r } of recs) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); headers.push(k) }
  return { headers, rows: recs.map(({ r }) => headers.map(h => r[h] ?? '')), lines: recs.map(x => x.line), source: 'jsonl' }
}

/** pandas to_csv writes array columns as "[0.1, 0.2]"; split those into name.0, name.1 ... */
export function expandArrays(t: Table): Table {
  const first = t.rows[0]
  if (!first) return t
  const arrCols = t.headers.map((_, i) => /^\s*\[.*\]\s*$/.test(first[i] ?? '') ? (first[i].match(/[^[\],\s]+/g) ?? []).length : 0)
  if (!arrCols.some(n => n > 0)) return t
  const headers = t.headers.flatMap((h, i) => arrCols[i] ? Array.from({ length: arrCols[i] }, (_, k) => `${h}.${k}`) : [h])
  const rows = t.rows.map(r => r.flatMap((c, i) => {
    if (!arrCols[i]) return [c]
    const parts = c.match(/[^[\],\s]+/g) ?? []
    return Array.from({ length: arrCols[i] }, (_, k) => parts[k] ?? '')
  }))
  return { ...t, headers, rows }
}

export function readTable(name: string, text: string): Table {
  const s = text.trimStart()
  return /\.jsonl?$/i.test(name) || s.startsWith('{') || s.startsWith('[{') ? parseJsonl(text) : parseCsv(text)
}

// ---------- Mapping ----------

export interface Mapping {
  episode: string
  timestamp: string
  /** Comma-separated column names or globs (observation.state.*). */
  joints: string
  action: string
  ee: string
  grip: string
  gripCmd: string
  task: string
  operator: string
  success: string
  tags: string
  camera: string
  topic: string
  jointTopic: string
  actionTopic: string
  gripTopic: string
  cameraTopics: string
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

export function resolveCols(headers: string[], pattern: string): string[] {
  const out: string[] = []
  for (const p of pattern.split(',').map(s => s.trim()).filter(Boolean)) {
    if (p.includes('*')) {
      const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i')
      out.push(...headers.filter(h => re.test(h) && !out.includes(h)).sort(natural))
    } else if (headers.includes(p) && !out.includes(p)) out.push(p)
  }
  return out
}

const pick = (headers: string[], re: RegExp) => headers.find(h => re.test(h)) ?? ''
const firstGlob = (headers: string[], globs: string[], min = 2) => globs.find(g => resolveCols(headers, g).length >= min) ?? ''

export function autoMap(headers: string[]): Mapping {
  return {
    episode: pick(headers, /^(episode(_index|_id|\.index)?|ep(_id|_index)?|demo(_id)?|trajectory(_id)?|bag|run(_id)?)$/i),
    timestamp: pick(headers, /^(timestamp|time|t|stamp|%time|ts|time_s|header\.stamp|field\.header\.stamp)$/i) || pick(headers, /stamp|time/i),
    joints: firstGlob(headers, ['observation.state.*', 'observation.joint_pos*', 'joint_pos*', 'qpos*', 'q_*', 'q0,q1,q2,q3,q4,q5,q6,q7', 'field.position*', 'position*', 'state.*', 'j1,j2,j3,j4,j5,j6,j7', 'joint_*']),
    action: firstGlob(headers, ['action.joint*', 'action.*', 'action_*', 'cmd_*', 'q_cmd*', 'qcmd*', 'field.data*']),
    ee: firstGlob(headers, ['observation.ee_pos.*', 'ee_pos*', 'ee_x,ee_y,ee_z', 'eef_pos*', 'tcp_x,tcp_y,tcp_z', 'observation.eef_pos.*', 'ee.*'], 3),
    grip: pick(headers, /^(gripper|gripper_pos|gripper_width|gripper_opening|grip|observation\.gripper(_pos)?|gripper_state)$/i),
    gripCmd: pick(headers, /^(gripper_cmd|gripper_command|action\.gripper|grip_cmd|gripper_action)$/i),
    task: pick(headers, /^(task|task_name|tasks(\.0)?|instruction|language_instruction|task_index)$/i),
    operator: pick(headers, /^(operator|operator_id|teleoperator|collector|user|pilot)$/i),
    success: pick(headers, /^(success|is_success|outcome|next\.success|label)$/i),
    tags: pick(headers, /^(tags|tag|labels)$/i) || (headers.some(h => /^tags\.\d+$/.test(h)) ? 'tags.*' : ''),
    camera: pick(headers, /^(camera|cam|camera_name|sensor|stream)$/i),
    topic: pick(headers, /^(topic|%topic|channel)$/i),
    jointTopic: 'joint_states',
    actionTopic: 'command|action|joint_cmd',
    gripTopic: 'gripper',
    cameraTopics: 'image|camera|rgb',
  }
}

export function detectKind(headers: string[], m = autoMap(headers)): Kind {
  if (m.topic) return 'ros'
  if (m.camera && m.timestamp && !m.joints) return 'cameras'
  if (m.joints && m.timestamp) return 'frames'
  return 'episodes'
}

// ---------- Values ----------

/** Seconds from numbers in s, ms, us or ns (by magnitude), or ISO 8601 strings. */
export function parseStamp(raw: string): number {
  const s = raw.trim()
  if (!s) return NaN
  if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) {
    const n = Number(s)
    const a = Math.abs(n)
    return a > 1e17 ? n / 1e9 : a > 1e14 ? n / 1e6 : a > 1e11 ? n / 1e3 : n
  }
  // ROS "secs.nsecs" with zero-padded nsecs is plain decimal; "1700000000:123" style is secs:nsecs
  const sn = s.match(/^(\d+)[:](\d{1,9})$/)
  if (sn) return Number(sn[1]) + Number(sn[2].padEnd(9, '0')) / 1e9
  const d = Date.parse(s)
  return Number.isNaN(d) ? NaN : d / 1000
}

export function parseSuccess(raw: string): boolean | null {
  const s = raw.trim().toLowerCase()
  if (/^(true|1|1\.0|yes|y|success|succeeded|ok|pass)$/.test(s)) return true
  if (/^(false|0|0\.0|no|n|fail|failed|failure|error)$/.test(s)) return false
  return null
}

const num = (s: string) => { const t = s.trim(); return t === '' ? NaN : Number(t) }

// ---------- Validation and build ----------

export interface Issue { line: number; level: 'error' | 'warn'; message: string }
export interface Meta { task?: string; operator?: string; success?: boolean | null; tags?: string[] }

export interface Built {
  kind: Kind
  episodes: Episode[]
  cams: Record<string, Record<string, number[]>>
  meta: Record<string, Meta>
  issues: Issue[]
  rows: number
  skipped: number
}

const MAX_ISSUES = 500

export function build(t: Table, kind: Kind, m: Mapping, fileName = 'file'): Built {
  const out: Built = { kind, episodes: [], cams: {}, meta: {}, issues: [], rows: t.rows.length, skipped: 0 }
  const col = (name: string) => name ? t.headers.indexOf(name) : -1
  const issue = (line: number, level: Issue['level'], message: string) => { if (out.issues.length < MAX_ISSUES) out.issues.push({ line, level, message }) }
  const skip = (line: number, message: string) => { out.skipped++; issue(line, 'error', message) }
  const iEp = col(m.episode), iT = col(m.timestamp)
  const defaultEp = fileName.replace(/\.[^.]+$/, '')
  const epOf = (r: string[]) => iEp >= 0 ? r[iEp].trim() : defaultEp
  const errCol = t.headers.indexOf('__error')

  if (kind === 'episodes') {
    if (iEp < 0) { issue(0, 'error', 'Map the episode id column to attach metadata.'); return out }
    const iTask = col(m.task), iOp = col(m.operator), iS = col(m.success)
    const tagCols = resolveCols(t.headers, m.tags).map(h => t.headers.indexOf(h))
    t.rows.forEach((r, k) => {
      const line = t.lines[k]
      if (errCol >= 0 && r[errCol]) return skip(line, r[errCol])
      const id = epOf(r)
      if (!id) return skip(line, 'Missing episode id')
      const meta: Meta = {}
      if (iTask >= 0 && r[iTask]) meta.task = r[iTask].trim()
      if (iOp >= 0 && r[iOp]) meta.operator = r[iOp].trim()
      if (iS >= 0) { meta.success = parseSuccess(r[iS]); if (r[iS].trim() && meta.success === null) issue(line, 'warn', `Success value "${r[iS]}" not understood; left unlabelled`) }
      if (tagCols.length) meta.tags = tagCols.flatMap(i => (r[i] ?? '').split(/[;|]/)).map(s => s.trim()).filter(Boolean)
      out.meta[id] = meta
    })
    return out
  }

  if (iT < 0) { issue(0, 'error', 'Map the timestamp column.'); return out }

  if (kind === 'cameras') {
    const iC = col(m.camera)
    t.rows.forEach((r, k) => {
      const line = t.lines[k]
      const id = epOf(r), ts = parseStamp(r[iT] ?? '')
      if (!id) return skip(line, 'Missing episode id')
      if (!Number.isFinite(ts)) return skip(line, `Timestamp "${r[iT]}" is not a number or ISO date`)
      const cam = iC >= 0 ? r[iC].trim() || 'camera' : 'camera'
      ;((out.cams[id] ??= {})[cam] ??= []).push(ts)
    })
    for (const [id, cs] of Object.entries(out.cams)) for (const [c, ts] of Object.entries(cs)) {
      if (ts.some((x, i) => i > 0 && x < ts[i - 1])) issue(0, 'warn', `${id} / ${c}: timestamps out of order, sorted`)
      cs[c] = [...new Set(ts)].sort((a, b) => a - b)
    }
    return out
  }

  const jointCols = resolveCols(t.headers, m.joints).map(h => t.headers.indexOf(h))
  const iG = col(m.grip), iGC = col(m.gripCmd), iTask = col(m.task), iOp = col(m.operator), iS = col(m.success)
  const actCols = resolveCols(t.headers, m.action).map(h => t.headers.indexOf(h)).filter(i => !jointCols.includes(i) && i !== iG && i !== iGC)
  const eeCols = resolveCols(t.headers, m.ee).slice(0, 3).map(h => t.headers.indexOf(h))
  if (!jointCols.length) { issue(0, 'error', 'No joint position columns matched. Set the joint columns pattern.'); return out }

  interface Acc { id: string; rows: { t: number; q: number[]; a?: number[]; g?: number; gc?: number; ee?: number[] }[]; cams: Record<string, number[]>; task?: string; op?: string; s?: boolean | null; line: number; lastG?: number; lastGc?: number; lastA?: number[] }
  const acc = new Map<string, Acc>()
  const get = (id: string, line: number) => { let a = acc.get(id); if (!a) { a = { id, rows: [], cams: {}, line }; acc.set(id, a) } return a }
  const topicCol = col(m.topic)
  const reOf = (s: string) => { try { return new RegExp(s, 'i') } catch { return /$^/ } }
  const reJ = reOf(m.jointTopic), reA = reOf(m.actionTopic), reG = reOf(m.gripTopic), reC = reOf(m.cameraTopics)
  // Joint values of the joint topic only; ROS rows of other topics leave those cells empty.
  const numsAt = (r: string[], cols: number[]) => cols.map(i => num(r[i] ?? ''))

  t.rows.forEach((r, k) => {
    const line = t.lines[k]
    if (errCol >= 0 && r[errCol]) return skip(line, r[errCol])
    const id = epOf(r)
    if (!id) return skip(line, 'Missing episode id')
    const ts = parseStamp(r[iT] ?? '')
    if (!Number.isFinite(ts)) return skip(line, `Timestamp "${r[iT] ?? ''}" is not a number or ISO date`)
    const a = get(id, line)
    if (kind === 'ros') {
      const topic = (r[topicCol] ?? '').trim()
      if (reC.test(topic)) { (a.cams[topic.replace(/^\//, '').replace(/\/(image_raw|image|compressed)$/g, '')] ??= []).push(ts); return }
      if (reG.test(topic) && !reJ.test(topic)) {
        const g = num(r[iG] ?? '')
        if (Number.isFinite(g)) a.lastG = g
        if (iGC >= 0 && Number.isFinite(num(r[iGC] ?? ''))) a.lastGc = num(r[iGC])
        return
      }
      if (reA.test(topic) && !reJ.test(topic)) {
        const v = numsAt(r, actCols.length ? actCols : jointCols)
        if (v.every(Number.isFinite)) a.lastA = v
        return
      }
      if (!reJ.test(topic)) return
    }
    const q = numsAt(r, jointCols)
    const bad = q.findIndex(x => !Number.isFinite(x))
    if (bad !== -1) return skip(line, `Joint value "${r[jointCols[bad]] ?? ''}" in ${t.headers[jointCols[bad]]} is not a number`)
    const row: Acc['rows'][number] = { t: ts, q }
    if (kind === 'ros') { if (a.lastA) row.a = a.lastA; if (a.lastG !== undefined) row.g = a.lastG; if (a.lastGc !== undefined) row.gc = a.lastGc }
    else {
      if (actCols.length) { const v = numsAt(r, actCols); if (v.every(Number.isFinite)) row.a = v; else issue(line, 'warn', 'Action value missing, frame kept without it') }
      if (iG >= 0) { const g = num(r[iG]); if (Number.isFinite(g)) row.g = g }
      if (iGC >= 0) { const g = num(r[iGC]); if (Number.isFinite(g)) row.gc = g }
    }
    if (eeCols.length === 3) { const v = numsAt(r, eeCols); if (v.every(Number.isFinite)) row.ee = v }
    if (iTask >= 0 && r[iTask] && !a.task) a.task = r[iTask].trim()
    if (iOp >= 0 && r[iOp] && !a.op) a.op = r[iOp].trim()
    if (iS >= 0 && r[iS].trim()) a.s = parseSuccess(r[iS])
    a.rows.push(row)
  })

  // Gripper scale: normalize to 0..1 when values look like mm or radians of finger travel.
  const gMax = Math.max(0, ...[...acc.values()].flatMap(a => a.rows.map(r => r.g ?? 0)))
  if (gMax > 1.05) issue(0, 'warn', `Gripper values go up to ${+gMax.toFixed(3)}; scaled so ${+gMax.toFixed(3)} = fully open`)
  const gScale = gMax > 1.05 ? gMax : 1

  for (const a of acc.values()) {
    let rows = a.rows
    if (rows.some((r, i) => i > 0 && r.t < rows[i - 1].t)) { issue(a.line, 'warn', `Episode ${a.id}: timestamps out of order, sorted`); rows = [...rows].sort((x, y) => x.t - y.t) }
    const dedup = rows.filter((r, i) => i === 0 || r.t !== rows[i - 1].t)
    if (dedup.length < rows.length) issue(a.line, 'warn', `Episode ${a.id}: ${rows.length - dedup.length} duplicate timestamps dropped`)
    rows = dedup
    if (rows.length < 4) { out.skipped += rows.length; issue(a.line, 'warn', `Episode ${a.id}: only ${rows.length} frames, skipped`); continue }
    const nJ = rows[0].q.length
    const t0 = rows[0].t
    // Streams logged at their own rate (ROS) or with gaps: hold the last value, back-fill the start.
    const fill = <T,>(vals: (T | undefined)[]): T[] | null => {
      const first = vals.find(v => v !== undefined)
      if (first === undefined) return null
      let last: T = first
      return vals.map(v => (last = v ?? last))
    }
    const A = fill(rows.map(r => r.a && r.a.length === nJ ? r.a : undefined))
    const G = fill(rows.map(r => r.g))
    const GC = fill(rows.map(r => r.gc))
    const allEe = rows.every(r => r.ee)
    const cams = Object.fromEntries(Object.entries(a.cams).map(([c, ts]) => [c, [...new Set(ts)].sort((x, y) => x - y).map(x => x - t0)]))
    out.episodes.push({
      id: a.id, task: a.task ?? 'unlabelled task', operator: a.op ?? 'unknown', success: a.s ?? null, tags: [],
      t: rows.map(r => r.t - t0), q: rows.map(r => r.q),
      ...(A ? { act: A } : {}),
      ...(G ? { grip: G.map(g => g / gScale) } : {}),
      ...(GC ? { gripCmd: GC.map(g => g >= 0.5 ? 1 : 0) } : {}),
      ...(allEe ? { ee: rows.map(r => r.ee!) } : {}),
      cams, t0,
    })
  }
  return out
}

export interface MergeReport { added: number; replaced: number; camsAttached: number; metaAttached: number; unmatched: string[] }

/** Merges an import into the dataset: frames add or replace episodes by id; cameras and metadata attach to existing ones. */
export function merge(ds: Episode[], b: Built): { ds: Episode[]; report: MergeReport } {
  const by = new Map(ds.map(e => [e.id, e]))
  const report: MergeReport = { added: 0, replaced: 0, camsAttached: 0, metaAttached: 0, unmatched: [] }
  for (const e of b.episodes) {
    const prev = by.get(e.id)
    if (prev) { report.replaced++; by.set(e.id, { ...e, task: e.task === 'unlabelled task' ? prev.task : e.task, operator: e.operator === 'unknown' ? prev.operator : e.operator, success: e.success ?? prev.success, tags: prev.tags, cams: Object.keys(e.cams).length ? e.cams : prev.cams }) }
    else { report.added++; by.set(e.id, e) }
  }
  for (const [id, cams] of Object.entries(b.cams)) {
    const e = by.get(id)
    if (!e) { report.unmatched.push(id); continue }
    const t0 = e.t0 ?? 0
    // Absolute camera stamps against relative joint stamps: shift by the episode's original start.
    by.set(id, { ...e, cams: { ...e.cams, ...Object.fromEntries(Object.entries(cams).map(([c, ts]) => [c, ts.map(x => x - t0)])) } })
    report.camsAttached++
  }
  for (const [id, m] of Object.entries(b.meta)) {
    const e = by.get(id)
    if (!e) { report.unmatched.push(id); continue }
    by.set(id, { ...e, task: m.task ?? e.task, operator: m.operator ?? e.operator, success: m.success !== undefined ? m.success : e.success, tags: m.tags ?? e.tags })
    report.metaAttached++
  }
  return { ds: [...by.values()], report }
}

// ---------- Export (used for the sample download and round-trip tests) ----------

export function framesCsv(eps: Episode[]): string {
  const nJ = eps[0]?.q[0]?.length ?? 0
  const J = Array.from({ length: nJ }, (_, i) => i)
  const head = ['episode_index', 'frame_index', 'timestamp', ...J.map(i => `observation.state.${i}`), ...J.map(i => `action.${i}`), 'observation.gripper', 'action.gripper', 'observation.ee_pos.0', 'observation.ee_pos.1', 'observation.ee_pos.2']
  const lines = [head.join(',')]
  const f = (x: number | undefined, d = 5) => x === undefined ? '' : x.toFixed(d)
  for (const e of eps) e.t.forEach((t, k) => {
    lines.push([e.id, k, t.toFixed(4), ...e.q[k].map(x => f(x)), ...(e.act ? e.act[k].map(x => f(x)) : J.map(() => '')), f(e.grip?.[k], 4), e.gripCmd?.[k] ?? '', ...(e.ee ? e.ee[k].map(x => f(x)) : ['', '', ''])].join(','))
  })
  return lines.join('\n') + '\n'
}

export function camerasCsv(eps: Episode[]): string {
  const lines = ['episode_index,camera,timestamp']
  for (const e of eps) for (const [c, ts] of Object.entries(e.cams)) for (const t of ts) lines.push(`${e.id},${c},${t.toFixed(4)}`)
  return lines.join('\n') + '\n'
}

export function episodesJsonl(eps: Episode[]): string {
  return eps.map(e => JSON.stringify({ episode_index: e.id, tasks: [e.task], operator: e.operator, success: e.success, tags: e.tags, length: e.t.length })).join('\n') + '\n'
}
