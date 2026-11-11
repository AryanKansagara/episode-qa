import { useMemo, useRef, useState } from 'react'
import { ConfigEditor } from './ConfigEditor.tsx'
import { makeVersion, curate } from './engine/curate.ts'
import { autoMap, build, camerasCsv, detectKind, episodesJsonl, framesCsv, KINDS, merge, readTable, resolveCols, type Built, type Kind, type Mapping, type Table } from './engine/parse.ts'
import type { Config } from './engine/types.ts'
import type { TabProps } from './Project.tsx'
import { analyzeAll, createBlankProject, derive } from './projectData.ts'
import { putData, saveProject, uuid, type Project } from './store.ts'
import { RAW_SYNC_LIMIT, useSync } from './sync.ts'
import { ask, download, go, Link, toast } from './ui.tsx'

interface Pending { id: string; name: string; table: Table; kind: Kind; map: Mapping }

const SCALARS: Record<Kind, [keyof Mapping, string, boolean][]> = {
  frames: [['episode', 'Episode id', true], ['timestamp', 'Timestamp', true], ['grip', 'Gripper opening', false], ['gripCmd', 'Gripper command', false], ['task', 'Task', false], ['operator', 'Operator', false], ['success', 'Success label', false]],
  cameras: [['episode', 'Episode id', true], ['camera', 'Camera name', false], ['timestamp', 'Frame timestamp', true]],
  episodes: [['episode', 'Episode id', true], ['task', 'Task', false], ['operator', 'Operator', false], ['success', 'Success label', false]],
  ros: [['topic', 'Topic', true], ['timestamp', 'Stamp', true], ['episode', 'Episode / bag id (blank = file name)', false], ['grip', 'Gripper value (gripper topic)', false], ['gripCmd', 'Gripper command field', false]],
}
const VECTORS: Record<Kind, [keyof Mapping, string][]> = {
  frames: [['joints', 'Joint positions'], ['action', 'Commanded joint targets'], ['ee', 'End-effector x, y, z']],
  cameras: [], episodes: [['tags', 'Tags']],
  ros: [['joints', 'Joint positions (joint topic)'], ['action', 'Action fields (action topic)'], ['ee', 'End-effector x, y, z']],
}
const TOPICS: [keyof Mapping, string][] = [['jointTopic', 'Joint topic matches'], ['actionTopic', 'Action topic matches'], ['gripTopic', 'Gripper topic matches'], ['cameraTopics', 'Camera topics match']]

export default function DataTab({ project, ds, d }: TabProps) {
  const [pending, setPending] = useState<Pending[]>([])
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const sync = useSync()
  const rawSize = useMemo(() => project.sampleId ? 0 : JSON.stringify(ds).length, [ds, project.sampleId])

  const readFiles = async (files: FileList | File[]) => {
    setBusy(true)
    const next: Pending[] = []
    for (const f of [...files]) {
      if (f.size > 300_000_000) { toast(`${f.name} is over 300 MB. Split it by episode range.`, { tone: 'error' }); continue }
      if (/\.(parquet|bag|mcap|db3)$/i.test(f.name)) { toast(`${f.name}: binary format. See Docs for the one-line conversion to CSV.`, { tone: 'error', action: { label: 'Docs', run: () => go('/docs#convert') } }); continue }
      try {
        const table = readTable(f.name, await f.text())
        if (!table.rows.length) { toast(`${f.name} has no data rows.`, { tone: 'error' }); continue }
        const map = autoMap(table.headers)
        next.push({ id: uuid(), name: f.name, table, kind: detectKind(table.headers, map), map })
      } catch (e) { toast(`${f.name}: ${e instanceof Error ? e.message : 'could not be read'}`, { tone: 'error' }) }
    }
    // Frames first, so camera and metadata files in the same drop have episodes to attach to.
    const order: Kind[] = ['frames', 'ros', 'cameras', 'episodes']
    setPending(p => [...p, ...next].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)))
    setBusy(false)
  }

  const commit = async (p: Pending, b: Built) => {
    const target: Project = project.sampleId ? await createBlankProject('My dataset') : project
    const base = project.sampleId ? [] : ds
    const { ds: merged, report } = merge(base, b)
    if (!merged.length) { toast('Nothing to attach yet: import the per-frame table first.', { tone: 'error' }); return }
    await putData(target.id, merged)
    const stats = analyzeAll(merged, target.config)
    const dv = derive(stats, target.tagEdits, target.config)
    const decisions = curate(dv.stats, target.rules, target.overrides, dv.ctx)
    const meta = { id: uuid(), kind: p.kind, fileName: p.name, rows: b.rows, skipped: b.skipped, episodes: b.episodes.length || Object.keys(b.cams).length || Object.keys(b.meta).length, at: Date.now() }
    const what = b.kind === 'cameras' ? `camera timestamps for ${report.camsAttached} episodes` : b.kind === 'episodes' ? `metadata for ${report.metaAttached} episodes` : `${report.added} new, ${report.replaced} replaced episodes`
    const v = makeVersion(uuid(), `Import ${p.name}`, 'import', dv.stats, decisions, target.rules)
    await saveProject({ ...target, stats, imports: [...target.imports, meta], versions: [...target.versions, v], log: [...target.log, { at: Date.now(), text: `Imported ${p.name}: ${what}` }], dataMissing: false })
    setPending(x => x.filter(y => y.id !== p.id))
    toast(`Imported ${what}${report.unmatched.length ? `; ${report.unmatched.length} ids did not match an episode` : ''}`, { tone: report.unmatched.length ? 'error' : 'ok' })
    if (project.sampleId) go(`/app/p/${target.id}/data`)
  }

  const setConfig = (c: Config) => {
    const stats = ds.length ? analyzeAll(ds, c) : project.stats
    void saveProject({ ...project, config: c, stats })
  }

  return (
    <>
      {!project.stats.length && !pending.length && (
        <div className="banner"><span><strong>Start here.</strong> Export episodes from your logger or LeRobot dataset (<Link href="/docs">exact steps</Link>), then drop the files below. Or <Link href="/app?sample=1">open the synthetic sample</Link>.</span></div>
      )}
      <div className="panel">
        <div className="panel-head"><h2>Import</h2><span className="muted small">Per-frame CSV / JSONL · LeRobot episodes.jsonl · camera timestamps · ROS bag CSV</span></div>
        {project.sampleId && <p className="muted small">This is a synthetic sample, so its data is read-only. Importing here starts a new dataset. Want to rehearse? Download the sample as <button type="button" className="linkish" onClick={() => download('sample-frames.csv', framesCsv(ds))}>frames CSV</button>, <button type="button" className="linkish" onClick={() => download('sample-cameras.csv', camerasCsv(ds))}>camera timestamps</button> and <button type="button" className="linkish" onClick={() => download('sample-episodes.jsonl', episodesJsonl(ds), 'application/json')}>episodes.jsonl</button>, then drop them back in.</p>}
        <div className={`drop${drag ? ' over' : ''}`} role="button" tabIndex={0} aria-label="Choose CSV or JSONL files to import"
          onClick={() => input.current?.click()} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click() } }}
          onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); void readFiles(e.dataTransfer.files) }}>
          <h3>{busy ? 'Reading files' : 'Drop episode files here, or click to choose'}</h3>
          <p className="muted small" style={{ margin: 0 }}>Parsed in your browser. Several files at once is fine; frames are imported before cameras and metadata. Re-importing an episode id replaces it.</p>
          <input ref={input} type="file" accept=".csv,.tsv,.txt,.json,.jsonl" multiple hidden onChange={e => { if (e.target.files) void readFiles(e.target.files); e.target.value = '' }} />
        </div>
      </div>

      {pending.map(p => <PendingFile key={p.id} p={p} onChange={n => setPending(x => x.map(y => y.id === p.id ? n : y))} onCancel={() => setPending(x => x.filter(y => y.id !== p.id))} onCommit={commit} />)}

      <div className="panel">
        <div className="panel-head"><h2>Joint limits and thresholds</h2><span className="muted small">{ds.length ? 'Changes re-run every check instantly' : project.stats.length ? 'Raw frames are not on this device: only the duplicate distance takes effect until you re-import' : 'Used when you import'}</span></div>
        <ConfigEditor cfg={project.config} onChange={setConfig} />
      </div>

      {project.imports.length > 0 && (
        <div className="panel">
          <div className="panel-head"><h2>Imported data</h2><span className="muted small">{ds.length.toLocaleString()} episodes on this device{rawSize ? ` · ${(rawSize / 1e6).toFixed(2)} MB` : ''}</span></div>
          <div className="table-wrap"><table>
            <thead><tr><th>File</th><th>Kind</th><th className="num">Rows</th><th className="num">Episodes</th><th className="num">Skipped</th><th>When</th></tr></thead>
            <tbody>{[...project.imports].reverse().map(i => <tr key={i.id}><th scope="row" className="break">{i.fileName}</th><td>{KINDS[i.kind]?.split(' (')[0] ?? i.kind}</td><td className="num">{i.rows.toLocaleString()}</td><td className="num">{i.episodes}</td><td className="num">{i.skipped}</td><td className="small">{new Date(i.at).toLocaleString()}</td></tr>)}</tbody>
          </table></div>
          <p className="muted small">{sync.user
            ? project.sampleId ? 'The sample regenerates on every device; your rules, tags and versions sync.' : rawSize > RAW_SYNC_LIMIT ? `Raw frames are over ${(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB, so they stay on this device. Limits, rules, tags, per-episode results and versions sync.` : 'Raw frames, limits, rules, tags, per-episode results and versions sync to your account.'
            : 'Stored in this browser only. Sign in to sync across devices.'}</p>
          {!project.sampleId && <ClearData project={project} ds={ds} statsCount={d.stats.length} />}
        </div>
      )}
    </>
  )
}

function ClearData({ project, ds }: { project: Project; ds: TabProps['ds']; statsCount: number }) {
  return (
    <button type="button" className="btn sm danger-ghost" onClick={async () => {
      if (!(await ask('Clear imported data?', 'Removes every episode and result from this dataset on this device. Limits, rules and versions stay. You can undo for a few seconds.', 'Clear data'))) return
      const before = { ...project }
      await putData(project.id, [])
      await saveProject({ ...project, stats: [], imports: [], log: [...project.log, { at: Date.now(), text: 'Cleared imported data' }] })
      toast('Cleared imported data', { undo: async () => { await putData(project.id, ds); await saveProject(before) } })
    }}>Clear imported data</button>
  )
}

function PendingFile({ p, onChange, onCancel, onCommit }: { p: Pending; onChange(p: Pending): void; onCancel(): void; onCommit(p: Pending, b: Built): Promise<void> }) {
  const b = useMemo(() => build(p.table, p.kind, p.map, p.name), [p])
  const [busy, setBusy] = useState(false)
  const errors = b.issues.filter(i => i.level === 'error')
  const ready = p.kind === 'cameras' ? Object.keys(b.cams).length : p.kind === 'episodes' ? Object.keys(b.meta).length : b.episodes.length
  const setMap = (k: keyof Mapping, v: string) => onChange({ ...p, map: { ...p.map, [k]: v } })
  const frames = b.episodes.reduce((a, e) => a + e.t.length, 0)
  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="break">{p.name}</h2>
        <label className="row gap-sm small">Format
          <select value={p.kind} style={{ width: 'auto' }} onChange={e => onChange({ ...p, kind: e.target.value as Kind })}>
            {(Object.keys(KINDS) as Kind[]).map(k => <option key={k} value={k}>{KINDS[k]}</option>)}
          </select>
        </label>
      </div>
      <p className="muted small">{p.table.rows.length.toLocaleString()} rows · {p.table.headers.length} columns · {p.table.source.toUpperCase()}</p>
      <h3 className="small strong">Column mapping</h3>
      <div className="map-grid">
        {SCALARS[p.kind].map(([k, label, req]) => (
          <label key={k} className="field"><span>{label}{req ? ' *' : ''}</span>
            <select value={p.map[k]} onChange={e => setMap(k, e.target.value)}>
              <option value="">Not mapped</option>
              {p.table.headers.filter(h => h !== '__error').map(h => <option key={h} value={h}>{h}</option>)}
            </select>
          </label>
        ))}
        {VECTORS[p.kind].map(([k, label]) => {
          const cols = resolveCols(p.table.headers, p.map[k])
          return (
            <label key={k} className="field"><span>{label}</span>
              <input value={p.map[k]} onChange={e => setMap(k, e.target.value)} placeholder="observation.state.* or q0,q1,q2" />
              <small className="muted tiny break">{cols.length ? `${cols.length} columns: ${cols.slice(0, 4).join(', ')}${cols.length > 4 ? ' …' : ''}` : 'No columns match'}</small>
            </label>
          )
        })}
        {p.kind === 'ros' && TOPICS.map(([k, label]) => <label key={k} className="field"><span>{label} (regex)</span><input value={p.map[k]} onChange={e => setMap(k, e.target.value)} /></label>)}
      </div>
      <h3 className="small strong" style={{ marginTop: 8 }}>Validation</h3>
      <p className="small">
        <strong className="good-text">{ready.toLocaleString()} episodes ready</strong>
        {(p.kind === 'frames' || p.kind === 'ros') && <> · {frames.toLocaleString()} frames{b.episodes[0] ? ` · ${b.episodes[0].q[0].length} joints` : ''}{b.episodes.some(e => e.act) ? ' · actions' : ''}{b.episodes.some(e => e.grip) ? ' · gripper' : ''}{b.episodes.some(e => e.ee) ? ' · end-effector' : ''}{b.episodes.some(e => Object.keys(e.cams).length) ? ` · cameras: ${[...new Set(b.episodes.flatMap(e => Object.keys(e.cams)))].join(', ')}` : ''}</>}
        {b.skipped > 0 && <>, <strong className="error">{b.skipped} rows skipped</strong></>}
        {b.issues.length > errors.length && <>, {b.issues.length - errors.length} warnings</>}.
      </p>
      {b.issues.length > 0 && (
        <div className="issues" role="log" aria-label="Validation issues">
          {b.issues.slice(0, 200).map((i, k) => <div key={k} className={i.level === 'error' ? 'error-row' : ''}><span className="ln">{i.line ? `${p.table.source === 'jsonl' ? 'record' : 'line'} ${i.line}` : 'file'}</span><span>{i.message}</span></div>)}
          {b.issues.length >= 200 && <div><span className="ln" /><span className="muted">Showing the first 200</span></div>}
        </div>
      )}
      <div className="row gap" style={{ marginTop: 14 }}>
        <button type="button" className="btn primary" disabled={!ready || busy} onClick={async () => { setBusy(true); await onCommit(p, b); setBusy(false) }}>{busy ? 'Analyzing' : `Import ${ready.toLocaleString()} episodes`}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
