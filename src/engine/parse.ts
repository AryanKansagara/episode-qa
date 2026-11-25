import { median } from './analyze.ts'
import type { Episode } from './types.ts'

export interface Table {
  headers: string[]
  rows: string[][]
  lines: number[]
  source: 'csv' | 'jsonl'
  /** Problems found while reading: a cut-off last row (left out of rows), short rows (filled with blanks). */
  problems?: Issue[]
}
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
  let row: string[] = [], field = '', quoted = false, line = 1, rowLine = 1, quoteLine = 0
  const endRow = () => { row.push(field); field = ''; if (row.length > 1 || row[0] !== '') { rows.push(row); lines.push(rowLine) } row = [] }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false }
      else { if (c === '\n') line++; field += c }
    } else if (c === '"' && field === '') { quoted = true; quoteLine = line }
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; endRow(); line++; rowLine = line }
    else field += c
  }
  const openEnd = field !== '' || row.length > 0
  if (openEnd || quoted) endRow()
  const [headers = [], ...body] = rows
  const bodyLines = lines.slice(1)
  const problems: Issue[] = []
  const last = body.at(-1)
  // A header line ending in a delimiter adds nameless columns that rows may leave out.
  const width = headers.findLastIndex(h => h.trim() !== '') + 1
  if (quoted) {
    problems.push({ line: quoteLine, level: 'error', message: 'A quote opened on this line is never closed, so nothing from here on could be read' })
    if (last) { body.pop(); bodyLines.pop() }
  } else if (last && openEnd && last.length < width && !body.slice(0, -1).some(r => r.length === last.length)) {
    // No line break at the end and shorter than every other row: the file was cut mid-row.
    problems.push({ line: bodyLines.at(-1)!, level: 'error', message: `The file ends in the middle of this row (${last.length} of ${width} cells)` })
    body.pop(); bodyLines.pop()
  }
  const short = body.findIndex(r => r.length < width)
  if (short !== -1) {
    const n = body.filter(r => r.length < width).length
    problems.push({ line: bodyLines[short], level: 'warn', message: `${n} row${n > 1 ? 's have' : ' has'} fewer cells than the header, starting here; missing cells were read as blank` })
    for (const r of body) while (r.length < headers.length) r.push('')
  }
  return expandArrays({ headers: headers.map(h => h.trim()), rows: body, lines: bodyLines, source: 'csv', ...(problems.length ? { problems } : {}) })
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
    arr.forEach((o, i) => { const r: Record<string, string> = Object.create(null); flatten(o, '', r); recs.push({ r, line: i + 1 }) })
  } else {
    text.split(/\r?\n/).forEach((l, i) => {
      if (!l.trim()) return
      const r: Record<string, string> = Object.create(null)
      try { flatten(JSON.parse(l), '', r) } catch { r['__error'] = 'Not valid JSON' }
      recs.push({ r, line: i + 1 })
    })
  }
  const headers: string[] = []
  const seen = new Set<string>()
  for (const { r } of recs) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); headers.push(k) }
  return { headers, rows: recs.map(({ r }) => headers.map(h => r[h] ?? '')), lines: recs.map(x => x.line), source: 'jsonl' }
}

const LIST = /^\s*\[(.*)\]\s*$/s
const tokens = (c: string) => c.match(/[^[\],\s]+/g) ?? []
const isNum = (x: string) => /^(nan|none|null|[+-]?inf(inity)?)$/i.test(x) || Number.isFinite(Number(x))
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r' }
const unescape = (s: string) => s.replace(/\\(?:x([0-9a-f]{2})|u([0-9a-f]{4})|(.))/gis, (_, x, u, c) => c === undefined ? String.fromCharCode(parseInt(x ?? u, 16)) : ESCAPES[c] ?? c)

/** Items of a text list: ['a b', "c"] (Python, JSON), ['a' 'b'] (numpy) or [a b, c]. */
function textItems(cell: string): string[] {
  const inner = cell.match(LIST)?.[1]
  if (inner === undefined) return cell.trim() ? [cell.trim()] : []
  const out: string[] = []
  for (const m of inner.matchAll(/'((?:[^'\\]|\\.)*)'(?=\s*(?:[,'"]|$))|"((?:[^"\\]|\\.)*)"(?=\s*(?:[,'"]|$))|[^\s,][^,]*/gs)) {
    const quoted = m[1] ?? m[2]
    const s = quoted !== undefined ? unescape(quoted) : m[0].trim()
    out.push(quoted === undefined && /^(none|null|nan)$/i.test(s) ? '' : s)
  }
  return out
}

/** pandas to_csv writes array columns as "[0.1, 0.2]" or "['a b']"; split those into name.0, name.1 ... */
export function expandArrays(t: Table): Table {
  const cols = t.headers.map((_, i): { n: number; items(c: string): string[] } | null => {
    if (!t.rows.some(r => (r[i] ?? '').trimStart().startsWith('['))) return null
    const cells = t.rows.map(r => r[i] ?? '').filter(c => c.trim())
    const lists = cells.filter(c => LIST.test(c))
    if (lists.length * 2 <= cells.length) return null
    const parts = lists.map(tokens)
    if (parts.every(p => !p.length)) return { n: 1, items: c => LIST.test(c) ? [] : [c] }
    const numeric = parts.filter(p => p.length && p.every(isNum)).length
    if (numeric * 2 >= parts.filter(p => p.length).length) {
      // Vectors have one length; a damaged row must not set it for the others.
      const count = new Map<number, number>()
      for (const p of parts) if (p.length) count.set(p.length, (count.get(p.length) ?? 0) + 1)
      const n = [...count].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0]
      return { n, items: tokens }
    }
    // numpy wraps long arrays over several lines; text that happens to span lines in brackets stays text.
    if (lists.every(c => c.trim().includes('\n') && !/^\s*\[\s*['"]/.test(c))) return null
    return { n: lists.reduce((m, c) => Math.max(m, textItems(c).length), 1), items: textItems }
  })
  if (cols.every(c => !c)) return t
  const headers = t.headers.flatMap((h, i) => { const c = cols[i]; return c ? Array.from({ length: c.n }, (_, k) => `${h}.${k}`) : [h] })
  const rows = t.rows.map(r => r.flatMap((c, i) => {
    const a = cols[i]
    if (!a) return [c]
    const parts = a.items(c)
    return Array.from({ length: a.n }, (_, k) => parts[k] ?? '')
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
  /** Joint and action angle units: auto treats values beyond ±2π as degrees. */
  angles?: 'auto' | 'rad' | 'deg'
  /** Unit of plain-number timestamps: auto finds one unit for the whole column. */
  stamps?: 'auto' | StampUnit
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
    angles: 'auto',
    stamps: 'auto',
  }
}

export function detectKind(headers: string[], m = autoMap(headers)): Kind {
  if (m.topic) return 'ros'
  if (m.camera && m.timestamp && !m.joints) return 'cameras'
  if (m.joints && m.timestamp) return 'frames'
  return 'episodes'
}

// ---------- Values ----------

export type StampUnit = 's' | 'ms' | 'us' | 'ns'
const PER_SEC: Record<StampUnit, number> = { s: 1, ms: 1e3, us: 1e6, ns: 1e9 }
export const UNIT_NAME: Record<StampUnit, string> = { s: 'seconds', ms: 'milliseconds', us: 'microseconds', ns: 'nanoseconds' }
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i
// Date, or date and time with an optional offset; the space is how pandas writes it.
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i

/** Seconds from numbers (in `unit`, or s, ms, us or ns by magnitude), or ISO 8601 strings. */
export function parseStamp(raw: string, unit?: StampUnit): number {
  const s = raw.trim()
  if (!s) return NaN
  if (NUMBER.test(s)) {
    const n = Number(s)
    if (unit) return n / PER_SEC[unit]
    const a = Math.abs(n)
    return a > 1e17 ? n / 1e9 : a > 1e14 ? n / 1e6 : a > 1e11 ? n / 1e3 : n
  }
  // ROS "secs.nsecs" with zero-padded nsecs is plain decimal; "1700000000:123" style is secs:nsecs
  const sn = s.match(/^(\d+)[:](\d{1,9})$/)
  if (sn) return Number(sn[1]) + Number(sn[2].padEnd(9, '0')) / 1e9
  // Date.parse on its own finds a date in almost any text with a number ("frame 1" is 2001), so the shape is checked first.
  const iso = s.match(ISO)
  if (!iso) return NaN
  const [, y, mo, day, time, zone = ''] = iso
  if (new Date(Date.UTC(+y, +mo - 1, +day)).getUTCDate() !== +day) return NaN
  const offset = zone.toUpperCase().replace(/^([+-]\d{2}):?(\d{2})?$/, (_, h, min = '00') => `${h}:${min}`)
  const d = Date.parse(`${y}-${mo}-${day}` + (time ? `T${time.replace(',', '.')}${offset}` : ''))
  return Number.isNaN(d) ? NaN : d / 1000
}

/** Typical gap between stamps that follow each other, sorted first when many of them go back in time. */
function typicalGap(ts: number[]): number {
  const back = ts.filter((x, i) => i > 0 && x < ts[i - 1]).length
  const l = back > ts.length / 10 ? [...ts].sort((a, b) => a - b) : ts
  return median(l.slice(1).map((x, i) => x - l[i]).filter(d => d > 0))
}
/** Units whose sample rate for this gap would be about 0.5 Hz to 2 kHz. */
const unitOfGap = (g: number): StampUnit => g < 2 ? 's' : g < 500 ? 'ms' : g < 5e5 ? 'us' : 'ns'
/** Gaps that two units explain equally well (1 could be 1 s or 1 ms), or none does. */
const unclearGap = (g: number) => (g >= 0.5 && g < 2) || (g > 250 && g < 2000) || (g > 2.5e5 && g < 2e6) || g > 1e9
/** Epoch stamps between 2001 and 2100 in each unit. */
const isEpoch = (n: number) => (Object.values(PER_SEC)).some(k => n >= 978e6 * k && n < 4102e6 * k)

/**
 * One unit for the plain numbers of a timestamp column. Epoch values tell by their size; values relative to a start
 * tell by the typical gap within a stream. `unit` is undefined when every value is read by its own size.
 */
export function stampUnit(streams: Iterable<string[]>): { unit?: StampUnit; warn?: string } {
  const nums = [...streams].map(l => l.map(x => x.trim()).filter(x => NUMBER.test(x)).map(Number)).filter(l => l.length)
  const gaps = nums.map(typicalGap).filter(g => g > 0)
  if (!gaps.length) return {}
  const gap = median(gaps)
  if (nums.every(l => l.every(isEpoch))) {
    const secs = median(nums.map(l => typicalGap(l.map(x => parseStamp(String(x))))).filter(g => g > 0))
    // Uptime clocks can fall in the epoch range, but then their gaps would be minutes or hours.
    if (secs <= 10) {
      const units = new Set(nums.flatMap(l => l.map(bySize)))
      return units.size > 1 ? { warn: `Timestamps mix units (${[...units].map(u => UNIT_NAME[u]).join(', ')}); each was read by its size. Set the timestamp unit if that is wrong.` }
        : secs > 2 ? { warn: `Timestamps were read as ${UNIT_NAME[[...units][0]]} since 1970, which puts frames ${+secs.toPrecision(3)} s apart. Set the timestamp unit if that is wrong.` } : {}
    }
  }
  const unit = unitOfGap(gap)
  const per = `${+(gap / PER_SEC[unit]).toPrecision(3)} s apart`
  const others = [...new Set(gaps.filter(g => !unclearGap(g)).map(unitOfGap))].filter(u => u !== unit)
  if (others.length) return { unit, warn: `Timestamps were all read as ${UNIT_NAME[unit]}, but some episodes look like ${others.map(u => UNIT_NAME[u]).join(' or ')}. Import them separately or set the timestamp unit.` }
  if (unclearGap(gap)) return { unit, warn: `The timestamp unit is unclear: read as ${UNIT_NAME[unit]}, frames are ${per}. Set the timestamp unit if that is wrong.` }
  return unit === 's' ? { unit } : { unit, warn: `Timestamps were read as ${UNIT_NAME[unit]} (frames ${per}). Set the timestamp unit if that is wrong.` }
}
const bySize = (n: number): StampUnit => n > 1e17 ? 'ns' : n > 1e14 ? 'us' : n > 1e11 ? 'ms' : 's'

/**
 * Whether stamps start over: a stretch falls back by more than half of what came before and covers the same time again.
 * Single late or swapped samples, and parts of one recording in the wrong order, do not count.
 */
export function restarts(ts: number[]): boolean {
  const runs: { lo: number; hi: number; n: number }[] = []
  for (const x of ts) {
    const r = runs[runs.length - 1]
    if (r && x >= r.hi) { r.hi = x; r.n++ } else runs.push({ lo: x, hi: x, n: 1 })
  }
  return runs.some((r, i) => {
    const p = runs[i - 1]
    return p && p.n >= 4 && r.n >= 4 && p.hi - r.lo > (p.hi - p.lo) / 2 && runs.slice(0, i).some(e => e.n >= 4 && r.lo < e.hi && r.hi > e.lo)
  })
}

export function parseSuccess(raw: string): boolean | null {
  const s = raw.trim().toLowerCase()
  if (/^(true|1|1\.0|yes|y|success|succeeded|ok|pass)$/.test(s)) return true
  if (/^(false|0|0\.0|no|n|fail|failed|failure|error)$/.test(s)) return false
  return null
}

/** Task strings, minus the literal wrapping quotes some LeRobot exports keep ("\"Pick the lego...\""). */
export const cleanText = (s: string) => s.trim().replace(/^"(.*)"$/s, '$1').trim()

const num = (s: string) => { const t = s.trim(); return t === '' ? NaN : Number(t) }

// ---------- Validation and build ----------

export interface Issue { line: number; level: 'error' | 'warn'; message: string }
export interface Meta { task?: string; operator?: string; success?: boolean; tags?: string[] }

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
  for (const x of t.problems ?? []) { out.issues.push(x); if (x.level === 'error') out.skipped++ }
  const defaultEp = fileName.replace(/\.[^.]+$/, '')
  const epOf = (r: string[]) => iEp >= 0 ? r[iEp].trim() : defaultEp
  const errCol = t.headers.indexOf('__error')

  if (kind === 'episodes') {
    const metaBy = new Map<string, Meta>()
    if (iEp < 0) { issue(0, 'error', 'Map the episode id column to attach metadata.'); return out }
    const iTask = col(m.task), iOp = col(m.operator), iS = col(m.success)
    const tagCols = resolveCols(t.headers, m.tags).map(h => t.headers.indexOf(h))
    t.rows.forEach((r, k) => {
      const line = t.lines[k]
      if (errCol >= 0 && r[errCol]) return skip(line, r[errCol])
      const id = epOf(r)
      if (!id) return skip(line, 'Missing episode id')
      const meta: Meta = {}
      // A blank or unreadable cell says nothing, so it must not replace what is already known.
      if (iTask >= 0 && cleanText(r[iTask])) meta.task = cleanText(r[iTask])
      if (iOp >= 0 && r[iOp].trim()) meta.operator = r[iOp].trim()
      if (iS >= 0) {
        const ok = parseSuccess(r[iS])
        if (ok !== null) meta.success = ok
        else if (r[iS].trim()) issue(line, 'warn', `Success value "${r[iS]}" not understood; any existing label is kept`)
      }
      const tags = tagCols.flatMap(i => (r[i] ?? '').split(/[;|]/)).map(s => s.trim()).filter(Boolean)
      if (tags.length) meta.tags = tags
      metaBy.set(id, { ...metaBy.get(id), ...meta })
    })
    out.meta = Object.fromEntries(metaBy)
    return out
  }

  if (iT < 0) { issue(0, 'error', 'Map the timestamp column.'); return out }
  // One ROS bag is one episode by design; in the other formats the file name only stands in for a single recording.
  const named = iEp < 0 && kind !== 'ros'
  /** Says what reading a file without ids means; true when the file cannot be read as one recording. */
  const several = (streams: number[][]) => {
    const many = streams.some(restarts)
    if (many) issue(0, 'error', 'Timestamps start over, so this file holds more than one recording. Map the episode id column.')
    else issue(0, 'warn', `No episode id column is mapped, so the whole file is read as one episode named "${defaultEp}".`)
    return many
  }
  let unit = m.stamps === 'auto' ? undefined : m.stamps
  if (!unit) {
    // Camera and topic columns: each has its own rate, so its gaps are its own.
    const iStream = kind === 'cameras' ? col(m.camera) : kind === 'ros' ? col(m.topic) : -1
    const streams = new Map<string, string[]>()
    for (const r of t.rows) {
      const key = JSON.stringify([epOf(r), iStream >= 0 ? r[iStream] : ''])
      const l = streams.get(key)
      if (l) l.push(r[iT] ?? ''); else streams.set(key, [r[iT] ?? ''])
    }
    const found = stampUnit(streams.values())
    unit = found.unit
    if (found.warn) issue(0, 'warn', found.warn)
  }

  if (kind === 'cameras') {
    const iC = col(m.camera)
    const camsBy = new Map<string, Map<string, number[]>>()
    t.rows.forEach((r, k) => {
      const line = t.lines[k]
      const id = epOf(r), ts = parseStamp(r[iT] ?? '', unit)
      if (!id) return skip(line, 'Missing episode id')
      if (!Number.isFinite(ts)) return skip(line, `Timestamp "${r[iT]}" is not a number or ISO date`)
      const cam = iC >= 0 ? r[iC].trim() || 'camera' : 'camera'
      const cs = camsBy.get(id) ?? new Map<string, number[]>()
      camsBy.set(id, cs)
      const l = cs.get(cam)
      if (l) l.push(ts); else cs.set(cam, [ts])
    })
    if (named && several([...camsBy.values()].flatMap(cs => [...cs.values()]))) return out
    for (const [id, cs] of camsBy) for (const [c, ts] of cs) {
      if (ts.some((x, i) => i > 0 && x < ts[i - 1])) issue(0, 'warn', `${id} / ${c}: timestamps out of order, sorted`)
      cs.set(c, [...new Set(ts)].sort((a, b) => a - b))
    }
    out.cams = Object.fromEntries([...camsBy].map(([id, cs]) => [id, Object.fromEntries(cs)]))
    return out
  }

  const jointCols = resolveCols(t.headers, m.joints).map(h => t.headers.indexOf(h))
  const iG = col(m.grip), iGC = col(m.gripCmd), iTask = col(m.task), iOp = col(m.operator), iS = col(m.success)
  const actCols = resolveCols(t.headers, m.action).map(h => t.headers.indexOf(h)).filter(i => !jointCols.includes(i) && i !== iG && i !== iGC)
  const eeCols = resolveCols(t.headers, m.ee).slice(0, 3).map(h => t.headers.indexOf(h))
  if (!jointCols.length) { issue(0, 'error', 'No joint position columns matched. Set the joint columns pattern.'); return out }

  interface Acc { id: string; rows: { t: number; q: number[]; f: number; a?: number[]; g?: number; gc?: number; ee?: number[] }[]; cams: Map<string, number[]>; task?: string; op?: string; s?: boolean | null; line: number; lastG?: number; lastGc?: number; lastA?: number[]; badS?: boolean }
  const acc = new Map<string, Acc>()
  const get = (id: string, line: number) => { let a = acc.get(id); if (!a) { a = { id, rows: [], cams: new Map(), line }; acc.set(id, a) } return a }
  const topicCol = col(m.topic)
  const iF = kind === 'frames' ? t.headers.findIndex(h => /^frame_index$/i.test(h)) : -1
  const reOf = (s: string) => { try { return new RegExp(s, 'i') } catch { return /$^/ } }
  const reJ = reOf(m.jointTopic), reA = reOf(m.actionTopic), reG = reOf(m.gripTopic), reC = reOf(m.cameraTopics)
  // Joint values of the joint topic only; ROS rows of other topics leave those cells empty.
  const numsAt = (r: string[], cols: number[]) => cols.map(i => num(r[i] ?? ''))

  t.rows.forEach((r, k) => {
    const line = t.lines[k]
    if (errCol >= 0 && r[errCol]) return skip(line, r[errCol])
    const id = epOf(r)
    if (!id) return skip(line, 'Missing episode id')
    const ts = parseStamp(r[iT] ?? '', unit)
    if (!Number.isFinite(ts)) return skip(line, `Timestamp "${r[iT] ?? ''}" is not a number or ISO date`)
    const a = get(id, line)
    if (kind === 'ros') {
      const topic = (r[topicCol] ?? '').trim()
      if (reC.test(topic)) {
        const cam = topic.replace(/^\//, '').replace(/\/(image_raw|image|compressed)$/g, '')
        const l = a.cams.get(cam)
        if (l) l.push(ts); else a.cams.set(cam, [ts])
        return
      }
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
    const row: Acc['rows'][number] = { t: ts, q, f: iF >= 0 ? num(r[iF] ?? '') : NaN }
    if (kind === 'ros') { if (a.lastA) row.a = a.lastA; if (a.lastG !== undefined) row.g = a.lastG; if (a.lastGc !== undefined) row.gc = a.lastGc }
    else {
      if (actCols.length) { const v = numsAt(r, actCols); if (v.every(Number.isFinite)) row.a = v; else issue(line, 'warn', 'Action value missing, frame kept without it') }
      if (iG >= 0) { const g = num(r[iG]); if (Number.isFinite(g)) row.g = g }
      if (iGC >= 0) { const g = num(r[iGC]); if (Number.isFinite(g)) row.gc = g }
    }
    if (eeCols.length === 3) { const v = numsAt(r, eeCols); if (v.every(Number.isFinite)) row.ee = v }
    if (iTask >= 0 && cleanText(r[iTask]) && !a.task) a.task = (t.headers[iTask] === 'task_index' ? 'task ' : '') + cleanText(r[iTask])
    if (iOp >= 0 && r[iOp].trim() && !a.op) a.op = r[iOp].trim()
    if (iS >= 0 && r[iS].trim()) {
      const ok = parseSuccess(r[iS])
      if (ok !== null) a.s = ok
      else if (!a.badS) { a.badS = true; issue(line, 'warn', `Episode ${id}: success value "${r[iS]}" not understood and ignored`) }
    }
    a.rows.push(row)
  })

  if (named && several([...acc.values()].map(a => a.rows.map(r => r.t)))) return out

  // Gripper scale: normalize to 0..1 when values look like mm or radians of finger travel.
  let gMax = 0
  for (const a of acc.values()) for (const r of a.rows) gMax = Math.max(gMax, r.g ?? 0)
  if (gMax > 1.05) issue(0, 'warn', `Gripper values go up to ${+gMax.toFixed(3)}; scaled so ${+gMax.toFixed(3)} = fully open`)
  const gScale = gMax > 1.05 ? gMax : 1

  // Angle units: LeRobot Koch / SO-100 exports store joints in degrees; the checks work in radians.
  let qMax = 0
  for (const a of acc.values()) for (const r of a.rows) for (const x of r.q) qMax = Math.max(qMax, Math.abs(x))
  const deg = m.angles === 'deg' || (m.angles !== 'rad' && qMax > 2 * Math.PI + 0.5)
  if (deg) {
    const k = Math.PI / 180
    for (const a of acc.values()) for (const r of a.rows) { r.q = r.q.map(x => x * k); if (r.a) r.a = r.a.map(x => x * k) }
    if (m.angles !== 'deg') issue(0, 'warn', `Joint values reach ${+qMax.toFixed(1)}, so they were read as degrees and converted to radians. Set angle units to radians if that is wrong.`)
  }

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
    const frame = iF >= 0 && rows.every((r, i) => Number.isSafeInteger(r.f) && r.f >= 0 && (i === 0 || r.f > rows[i - 1].f)) ? rows.map(r => r.f) : null
    if (iF >= 0 && !frame) issue(a.line, 'warn', `Episode ${a.id}: frame_index does not count up in whole numbers, so frame numbers in exports count the rows that were kept`)
    const allEe = rows.every(r => r.ee)
    const cams = Object.fromEntries([...a.cams].map(([c, ts]) => [c, [...new Set(ts)].sort((x, y) => x - y).map(x => x - t0)]))
    out.episodes.push({
      id: a.id, task: a.task ?? 'unlabelled task', operator: a.op ?? 'unknown', success: a.s ?? null, tags: [],
      t: rows.map(r => r.t - t0), q: rows.map(r => r.q),
      ...(frame ? { frame } : {}),
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
    by.set(id, { ...e, task: m.task ?? e.task, operator: m.operator ?? e.operator, success: m.success ?? e.success, tags: m.tags ?? e.tags })
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
