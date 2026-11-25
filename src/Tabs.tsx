import { useEffect, useMemo, useState } from 'react'
import { balance, operatorFeedback, PENALTY_LABELS, scoreHistogram } from './engine/analyze.ts'
import { decisionsCsv, decisionsJson, describeRule, diffVersions, FIELD_META, matches, type Override, type Rule, type RuleAction, type RuleField, type RuleOp } from './engine/curate.ts'
import type { EpisodeStats, IssueKind } from './engine/types.ts'
import type { Tab, TabProps } from './Project.tsx'
import { fmtS } from './projectData.ts'
import { saveProject, uuid } from './store.ts'
import { deleteVersionCloud } from './sync.ts'
import { ask, Code, CopyButton, download, Empty, fmtN, fmtPct, go, isTyping, Link, toast } from './ui.tsx'
import { KIND_LABEL, KINDS, ScoreRing, Viewer } from './Viewer.tsx'

export default function Tabs(p: TabProps & { tab: Tab }) {
  switch (p.tab) {
    case 'episodes': return <Episodes {...p} />
    case 'operators': return <Operators {...p} />
    case 'balance': return <Balance {...p} />
    case 'curate': return <Curate {...p} />
    case 'history': return <History {...p} />
    default: return <Overview {...p} />
  }
}

const slug = (s: string) => s.replace(/\W+/g, '-').replace(/^-|-$/g, '').toLowerCase()
const epHref = (pid: string, id: string) => `/app/p/${pid}/episodes?ep=${encodeURIComponent(id)}`

function KindChips({ s }: { s: EpisodeStats }) {
  const counts = KINDS.map(k => [k, s.issues.filter(i => i.kind === k).length] as const).filter(([, n]) => n)
  if (!counts.length) return <span className="muted tiny">clean</span>
  return <span className="kchips">{counts.map(([k, n]) => <span key={k} className="kdot" title={`${KIND_LABEL[k]}: ${n}`} style={{ ['--k' as string]: `var(--k-${k})` }}><i />{n > 1 ? n : ''}</span>)}</span>
}

function KindLegend() {
  return <div className="legend">{KINDS.map(k => <span key={k}><i style={{ background: `var(--k-${k})` }} />{KIND_LABEL[k]}</span>)}</div>
}

// ---------------- Overview ----------------

function Overview({ project, d }: TabProps) {
  const { stats, keep, ops } = d
  const n = stats.length
  const hours = stats.reduce((a, s) => a + s.duration, 0)
  const keptHours = stats.filter(s => keep.has(s.id)).reduce((a, s) => a + s.duration, 0)
  const mean = stats.reduce((a, s) => a + s.score, 0) / n
  const hist = scoreHistogram(stats)
  const hmax = Math.max(...hist, 1)
  const byKind = KINDS.map(k => [k, stats.filter(s => s.issues.some(i => i.kind === k)).length] as const)
  const worst = [...stats].sort((a, b) => a.score - b.score).slice(0, 8)
  const camNames = [...new Set(stats.flatMap(s => s.cams.map(c => c.name)))]
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN }

  // Where issues concentrate: groups (tag, operator, task) whose issue rate is at least double the dataset's.
  const spots = useMemo(() => {
    const groups = new Map<string, EpisodeStats[]>()
    for (const s of stats) for (const g of [`operator ${s.operator}`, `task “${s.task}”`, ...s.tags.map(t => `tag ${t}`)]) groups.set(g, [...(groups.get(g) ?? []), s])
    const out: { g: string; k: IssueKind; rate: number; base: number; n: number }[] = []
    for (const k of KINDS) {
      const base = stats.filter(s => s.issues.some(i => i.kind === k)).length / n
      if (!base) continue
      for (const [g, l] of groups) {
        if (l.length < 5 || l.length === n) continue
        const rate = l.filter(s => s.issues.some(i => i.kind === k)).length / l.length
        if (rate >= base * 2 && rate >= 0.25) out.push({ g, k, rate, base, n: l.length })
      }
    }
    return out.sort((a, b) => b.rate / b.base - a.rate / a.base).slice(0, 6)
  }, [stats])

  return (
    <>
      <div className="kpis">
        <div className="kpi"><small>Episodes</small><b>{fmtN(n)}</b><p>{fmtS(hours)} recorded</p></div>
        <div className="kpi"><small>Mean quality score</small><b>{mean.toFixed(0)}</b><p>{stats.filter(s => s.score < 70).length} below 70</p></div>
        <div className="kpi"><small>Kept by current rules</small><b>{keep.size}</b><p>{fmtS(keptHours)} of training data · {fmtPct(keep.size / n)}</p></div>
        <div className="kpi"><small>Failed grasps</small><b>{stats.reduce((a, s) => a + s.failedGrasps, 0)}</b><p>{stats.filter(s => s.issues.some(i => i.kind === 'label')).length} contradict their success label</p></div>
      </div>
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><h2>Score distribution</h2><span className="muted small">100 = no penalties</span></div>
          <div className="hist" role="img" aria-label="Histogram of episode quality scores">
            {hist.map((v, i) => <div key={i} className="bar"><b>{v || ''}</b><span style={{ height: `${(v / hmax) * 100}%`, background: i >= 8 ? 'var(--good)' : i >= 7 ? 'var(--phoenix)' : 'var(--bad)' }} /><small>{i * 10}</small></div>)}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Episodes affected</h2><span className="muted small">at least one flag of each kind</span></div>
          <div className="kbars">
            {byKind.map(([k, c]) => (
              <div key={k} className="kbar"><span>{KIND_LABEL[k]}</span><div className="share"><span style={{ width: `${(c / n) * 100}%`, background: `var(--k-${k})` }} /></div><b className="tab-nums">{c}</b></div>
            ))}
          </div>
        </div>
      </div>
      {spots.length > 0 && (
        <div className="panel">
          <div className="panel-head"><h2>Where problems cluster</h2><span className="muted small">groups with at least twice the dataset&rsquo;s rate</span></div>
          <div className="spots">
            {spots.map(s => (
              <div key={s.g + s.k} className="spot" style={{ ['--k' as string]: `var(--k-${s.k})` }}>
                <b>{fmtPct(s.rate)}</b>
                <span><strong>{KIND_LABEL[s.k]}</strong> in {s.g} <span className="muted">({s.n} episodes) vs {fmtPct(s.base)} overall</span></span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><h2>Streams</h2><span className="muted small">median across episodes</span></div>
          <div className="table-wrap"><table>
            <thead><tr><th>Stream</th><th className="num">Rate</th><th className="num">Episodes with drops</th><th className="num">Offset</th></tr></thead>
            <tbody>
              <tr><th scope="row" className="mono">joint_states</th><td className="num">{med(stats.map(s => s.joints.hz)).toFixed(1)} Hz</td><td className="num">{stats.filter(s => s.joints.dropped).length}</td><td className="num muted">clock</td></tr>
              {camNames.map(c => { const cs = stats.flatMap(s => s.cams.filter(x => x.name === c)); return (
                <tr key={c}><th scope="row" className="mono">{c}</th><td className="num">{med(cs.map(x => x.hz)).toFixed(1)} Hz</td><td className="num">{cs.filter(x => x.dropped).length}</td><td className="num">{med(cs.map(x => Math.max(Math.abs(x.offsetMs), Math.abs(x.endOffsetMs)))).toFixed(0)} ms</td></tr>
              ) })}
            </tbody>
          </table></div>
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Worst episodes</h2><Link href={`/app/p/${project.id}/episodes`} className="small">All episodes</Link></div>
          <ul className="worst">
            {worst.map(s => <li key={s.id}><ScoreRing score={s.score} /><Link href={epHref(project.id, s.id)} className="mono">{s.id}</Link><span className="muted small grow">{s.operator} · {s.task}</span><KindChips s={s} /></li>)}
          </ul>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head"><h2>Operators at a glance</h2><Link href={`/app/p/${project.id}/operators`} className="small">Details and feedback</Link></div>
        <div className="op-cards">
          {ops.map(o => <div key={o.operator} className="op-card"><ScoreRing score={Math.round(o.meanScore)} /><div><b>{o.operator}</b><small className="muted">{o.episodes} episodes · {fmtPct(o.successRate)} success · {fmtPct(o.failedGraspRate)} grasps failed</small></div></div>)}
        </div>
      </div>
    </>
  )
}

// ---------------- Episodes ----------------

function Episodes({ project, ds, d, update }: TabProps) {
  const q0 = new URLSearchParams(location.search)
  const [sel, setSel] = useState<string | null>(q0.get('ep'))
  const [f, setF] = useState({ text: '', op: '', task: '', kind: '', dec: '', sort: 'score' })
  const dec = useMemo(() => new Map(d.decisions.map(x => [x.id, x])), [d.decisions])
  const list = useMemo(() => {
    const l = d.stats.filter(s =>
      (!f.text || s.id.toLowerCase().includes(f.text.toLowerCase()) || s.tags.some(t => t.includes(f.text.toLowerCase()))) &&
      (!f.op || s.operator === f.op) && (!f.task || s.task === f.task) &&
      (!f.kind || (f.kind === 'clean' ? !s.issues.length : s.issues.some(i => i.kind === f.kind))) &&
      (!f.dec || (f.dec === 'kept' ? d.keep.has(s.id) : f.dec === 'excluded' ? !d.keep.has(s.id) : f.dec === 'trimmed' ? !!dec.get(s.id)?.trim : !!project.overrides[s.id])))
    const by: Record<string, (a: EpisodeStats, b: EpisodeStats) => number> = { score: (a, b) => a.score - b.score, '-score': (a, b) => b.score - a.score, duration: (a, b) => b.duration - a.duration, id: (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }) }
    return l.sort(by[f.sort])
  }, [d.stats, f, d.keep, dec, project.overrides])
  const ops = [...new Set(d.stats.map(s => s.operator))].sort(), tasks = [...new Set(d.stats.map(s => s.task))].sort()
  const s = sel ? d.stats.find(x => x.id === sel) : null
  const raw = s ? ds.find(e => e.id === s.id) : undefined

  const open = (id: string | null) => { setSel(id); history.replaceState({}, '', `${location.pathname}${id ? `?ep=${encodeURIComponent(id)}` : ''}`); if (id) document.getElementById('ep-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  const setOverride = (id: string, o: Override | null) => {
    const before = project.overrides
    const next = { ...before }
    if (o) next[id] = o; else delete next[id]
    void update({ overrides: next }, o ? `Manual ${o}: ${id}` : `Manual override cleared: ${id}`)
    toast(o ? `${id} ${o === 'keep' ? 'always kept' : 'excluded'}` : `${id} back to rules`, { undo: () => void update({ overrides: before }) })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
      const i = list.findIndex(x => x.id === sel)
      if (e.key === 'j' && list.length) open(list[Math.min(list.length - 1, i + 1)].id)
      else if (e.key === 'k' && list.length) open(list[Math.max(0, i - 1)].id)
      else if (sel && e.key === 'x') setOverride(sel, 'exclude')
      else if (sel && e.key === 'a') setOverride(sel, 'keep')
      else if (sel && e.key === 'u') setOverride(sel, null)
      else if (e.key === 'Escape') open(null)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  return (
    <>
      {s && (
        <div className="panel ep-detail" id="ep-detail">
          <div className="panel-head">
            <h2 className="row gap-sm wrap"><span className="mono">{s.id}</span> <span className={`badge ${d.keep.has(s.id) ? 'kept' : 'excluded'}`}>{d.keep.has(s.id) ? 'Kept' : 'Excluded'}</span>{dec.get(s.id)?.trim && <span className="badge">Trim {dec.get(s.id)!.trim![0].toFixed(2)}–{dec.get(s.id)!.trim![1].toFixed(2)} s</span>}</h2>
            <div className="row gap-sm wrap">
              <button type="button" className="btn sm outline" onClick={() => setOverride(s.id, 'exclude')} title="X">Exclude</button>
              <button type="button" className="btn sm outline" onClick={() => setOverride(s.id, 'keep')} title="A">Always keep</button>
              {project.overrides[s.id] && <button type="button" className="btn sm ghost" onClick={() => setOverride(s.id, null)} title="U">Use rules</button>}
              <button type="button" className="icon-btn" aria-label="Close episode" onClick={() => open(null)}>&times;</button>
            </div>
          </div>
          {raw ? <Viewer key={raw.id} ep={raw} cfg={project.config} title={`${s.task} · ${s.operator}`} /> : <p className="muted small">The raw frames for this episode are not on this device, so the plot is unavailable. The results below come from the synced analysis.</p>}
          <div className="grid-2" style={{ marginTop: 18 }}>
            <div>
              <h3 className="small strong">Why it is {d.keep.has(s.id) ? 'kept' : 'excluded'}</h3>
              <ul className="small">{(dec.get(s.id)?.reasons.length ? dec.get(s.id)!.reasons : ['No exclude rule matches']).map(r => <li key={r}>{r}</li>)}</ul>
              <h3 className="small strong">Penalties</h3>
              <p className="small">{Object.entries(s.penalties).filter(([, v]) => v > 0.05).map(([k, v]) => `${PENALTY_LABELS[k]} −${v.toFixed(1)}`).join(' · ') || 'None'}</p>
              <dl className="mini-stats">
                <div><dt>Duration</dt><dd>{s.duration.toFixed(1)} s</dd></div>
                <div><dt>Joint rate</dt><dd>{s.joints.hz.toFixed(1)} Hz</dd></div>
                <div><dt>Worst drop rate</dt><dd>{fmtPct(s.dropRate, 1)}</dd></div>
                <div><dt>Camera offset</dt><dd>{s.syncMs.toFixed(0)} ms</dd></div>
              </dl>
            </div>
            <div>
              <h3 className="small strong">Tags</h3>
              <TagEditor key={s.id} tags={s.tags} onSave={tags => { const before = project.tagEdits; void update({ tagEdits: { ...before, [s.id]: tags } }, `Tags on ${s.id}: ${tags.join(', ') || 'none'}`); toast('Tags saved', { undo: () => void update({ tagEdits: before }) }) }} />
              <h3 className="small strong" style={{ marginTop: 14 }}>Issues ({s.issues.length})</h3>
              <div className="issues">{s.issues.length ? s.issues.map((i, k) => <div key={k}><span className="ln" style={{ color: `var(--k-${i.kind})` }}>{i.t.toFixed(2)} s</span><span>{i.msg}</span></div>) : <div><span className="muted">No issues</span></div>}</div>
            </div>
          </div>
        </div>
      )}
      <div className="panel">
        <div className="filters">
          <label className="field"><span>Search id or tag</span><input value={f.text} onChange={e => setF({ ...f, text: e.target.value })} placeholder="ep_01, rig-2" /></label>
          <label className="field"><span>Operator</span><select value={f.op} onChange={e => setF({ ...f, op: e.target.value })}><option value="">All</option>{ops.map(o => <option key={o}>{o}</option>)}</select></label>
          <label className="field"><span>Task</span><select value={f.task} onChange={e => setF({ ...f, task: e.target.value })}><option value="">All</option>{tasks.map(o => <option key={o}>{o}</option>)}</select></label>
          <label className="field"><span>Issue</span><select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })}><option value="">Any</option><option value="clean">No issues</option>{KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
          <label className="field"><span>Decision</span><select value={f.dec} onChange={e => setF({ ...f, dec: e.target.value })}><option value="">All</option><option value="kept">Kept</option><option value="excluded">Excluded</option><option value="trimmed">Trimmed</option><option value="manual">Manual override</option></select></label>
          <label className="field"><span>Sort</span><select value={f.sort} onChange={e => setF({ ...f, sort: e.target.value })}><option value="score">Worst first</option><option value="-score">Best first</option><option value="duration">Longest</option><option value="id">Episode id</option></select></label>
        </div>
        <div className="row between wrap gap"><span className="muted small">{list.length} of {d.stats.length} episodes · <kbd>J</kbd>/<kbd>K</kbd> to step through</span><KindLegend /></div>
        {list.length === 0 ? <Empty title="No episodes match"><button type="button" className="btn ghost sm" onClick={() => setF({ text: '', op: '', task: '', kind: '', dec: '', sort: 'score' })}>Clear filters</button></Empty> : (
          <div className="table-wrap">
            <table className="ep-table">
              <thead><tr><th>Episode</th><th>Task</th><th>Operator</th><th>Label</th><th className="num">Score</th><th>Issues</th><th className="num">Length</th><th>Decision</th></tr></thead>
              <tbody>{list.slice(0, 400).map(x => (
                <tr key={x.id} className={x.id === sel ? 'sel' : ''} onClick={() => open(x.id)}>
                  <th scope="row"><a href={epHref(project.id, x.id)} className="mono" onClick={e => { e.preventDefault(); open(x.id) }}>{x.id}</a></th>
                  <td>{x.task}</td><td>{x.operator}</td>
                  <td>{x.success === null ? <span className="muted">—</span> : x.success ? 'success' : <span className="error">fail</span>}</td>
                  <td className="num"><span className={`score-num t-${x.score >= 85 ? 'good' : x.score >= 70 ? 'ok' : 'bad'}`}>{x.score}</span></td>
                  <td><KindChips s={x} /></td>
                  <td className="num">{x.duration.toFixed(1)} s</td>
                  <td>{d.keep.has(x.id) ? <span className="badge kept">{dec.get(x.id)?.trim ? 'Keep, trim' : 'Keep'}</span> : <span className="badge excluded">Exclude</span>}{project.overrides[x.id] && <span className="muted tiny"> manual</span>}</td>
                </tr>
              ))}</tbody>
            </table>
            {list.length > 400 && <p className="muted small">Showing the first 400. Narrow the filters to see the rest.</p>}
          </div>
        )}
      </div>
    </>
  )
}

function TagEditor({ tags, onSave }: { tags: string[]; onSave(t: string[]): void }) {
  const [v, setV] = useState(tags.join(', '))
  return (
    <form className="row gap-sm" onSubmit={e => { e.preventDefault(); onSave([...new Set(v.split(/[,;]/).map(s => s.trim().toLowerCase()).filter(Boolean))]) }}>
      <input value={v} onChange={e => setV(e.target.value)} aria-label="Tags, comma separated" placeholder="clutter, dim-light" />
      <button className="btn sm outline">Save</button>
    </form>
  )
}

// ---------------- Operators ----------------

function Operators({ project, d }: TabProps) {
  const { ops } = d
  return (
    <>
      <div className="panel">
        <div className="panel-head"><h2>Operator quality</h2><Link href={`/app/p/${project.id}/feedback`} className="btn sm primary">Printable feedback sheet</Link></div>
        <div className="table-wrap"><table>
          <thead><tr><th>Operator</th><th className="num">Episodes</th><th className="num">Recorded</th><th className="num">Score</th><th className="num">Success</th><th className="num">Failed grasps</th><th className="num">Jerk / min</th><th className="num">Idle</th><th className="num">Edge idle</th><th className="num">At limit</th><th className="num">Drops</th><th className="num">Label issues</th></tr></thead>
          <tbody>{ops.map(o => (
            <tr key={o.operator}>
              <th scope="row"><div className="row gap-sm"><ScoreRing score={Math.round(o.meanScore)} />{o.operator}</div></th>
              <td className="num">{o.episodes}</td><td className="num">{fmtS(o.hours * 3600)}</td><td className="num">{o.meanScore.toFixed(0)}</td>
              <td className="num">{fmtPct(o.successRate)}</td><td className="num">{fmtPct(o.failedGraspRate)}</td><td className="num">{o.jerkPerMin.toFixed(1)}</td>
              <td className="num">{fmtPct(o.idleFrac)}</td><td className="num">{fmtPct(o.edgeIdleFrac)}</td><td className="num">{fmtPct(o.satFrac, 1)}</td><td className="num">{fmtPct(o.dropRate, 1)}</td><td className="num">{o.labelMismatches}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <p className="muted small">Score is the mean episode score. Drops and sync usually come from the rig, not the operator; they are listed so you can rule them out.</p>
      </div>
      <div className="grid-3">
        {ops.map(o => (
          <div key={o.operator} className="panel">
            <div className="row gap"><ScoreRing score={Math.round(o.meanScore)} /><h3 style={{ margin: 0 }}>{o.operator}</h3></div>
            <ul className="feedback">{operatorFeedback(o, ops).map(n => <li key={n}>{n}</li>)}</ul>
          </div>
        ))}
      </div>
    </>
  )
}

// ---------------- Balance & duplicates ----------------

function Balance({ project, d, update }: TabProps) {
  const [by, setBy] = useState<'task' | 'tag' | 'operator'>('task')
  const rows = balance(d.stats, d.keep, by)
  const byId = new Map(d.stats.map(s => [s.id, s]))
  const dist = (a: string, b: string) => d.pairs.find(p => (p.a === a && p.b === b) || (p.a === b && p.b === a))?.d
  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>Dataset balance</h2>
          <div className="seg-control" role="radiogroup" aria-label="Group by">
            {(['task', 'tag', 'operator'] as const).map(k => <button key={k} type="button" role="radio" aria-checked={by === k} className={by === k ? 'on' : ''} onClick={() => setBy(k)}>By {k}</button>)}
          </div>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>{by[0].toUpperCase() + by.slice(1)}</th><th className="num">Episodes</th><th className="num">Kept</th><th>Share of kept set</th><th className="num">Success</th><th /></tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.key}>
              <th scope="row">{r.key}</th><td className="num">{r.episodes}</td><td className="num">{r.kept}</td>
              <td><div className="share two"><span className="all" style={{ width: `${r.share * 100}%` }} /><span className={r.flag === 'over' ? 'over' : ''} style={{ width: `${r.keptShare * 100}%` }} /></div><small className="muted tab-nums">{fmtPct(r.keptShare)} kept · {fmtPct(r.share)} recorded</small></td>
              <td className="num">{r.labelled ? fmtPct(r.successes / r.labelled) : '—'}</td>
              <td>{r.flag === 'under' ? <span className="badge excluded">Under-represented</span> : r.flag === 'over' ? <span className="badge">Over-represented</span> : null}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <p className="muted small">{by === 'tag' ? 'Episodes can carry several tags, so shares can add up to more than 100%.' : 'Flags compare each group with an even split of the kept set: under half or over double. Collect more of an under-represented group rather than relaxing rules for it.'}</p>
      </div>
      <div className="panel">
        <div className="panel-head"><h2>Near-duplicate episodes</h2><span className="muted small">DTW on 32-point end-effector paths, same task, mean distance ≤ {project.config.th.dupDist} m</span></div>
        {d.clusters.length === 0 ? <p className="muted">No near-duplicates found.</p> : (
          <div className="dups">
            {d.clusters.map(c => (
              <div key={c.keep} className="dup">
                <div><span className="badge kept">Keep</span> <Link href={epHref(project.id, c.keep)} className="mono">{c.keep}</Link> <span className="muted small">score {byId.get(c.keep)?.score} · {byId.get(c.keep)?.operator}</span></div>
                {c.drop.map(x => (
                  <div key={x} className="row gap-sm wrap">
                    <span className="badge excluded">Duplicate</span> <Link href={epHref(project.id, x)} className="mono">{x}</Link>
                    <span className="muted small">distance {dist(c.keep, x)?.toFixed(4) ?? '—'} m · score {byId.get(x)?.score}</span>
                    {project.overrides[x] !== 'keep' && <button type="button" className="linkish small" onClick={() => { const before = project.overrides; void update({ overrides: { ...before, [x]: 'keep' } }, `Kept duplicate ${x} on purpose`); toast(`${x} kept`, { undo: () => void update({ overrides: before }) }) }}>Not a duplicate, keep it</button>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        <p className="muted small">Common causes: the same bag exported twice, an episode replayed for a demo, or a logger that did not rotate files. The best-scoring copy is kept.</p>
      </div>
    </>
  )
}

// ---------------- Curate & export ----------------

const OPS: RuleOp[] = ['<', '>', '=', '!=']
const ACTIONS: [RuleAction, string][] = [['exclude', 'Exclude'], ['keep', 'Always keep'], ['trim', 'Trim idle edges']]

function Curate({ project, d, update }: TabProps) {
  const rules = project.rules
  const setRules = (next: Rule[], log: string) => {
    const before = rules
    void update({ rules: next }, log)
    if (/Removed/.test(log)) toast(log, { undo: () => void update({ rules: before }, 'Undid rule removal') })
  }
  const patch = (id: string, p: Partial<Rule>, log?: string) => setRules(rules.map(r => r.id === id ? { ...r, ...p } : r), log ?? `Edited rule: ${describeRule({ ...rules.find(r => r.id === id)!, ...p })}`)
  const kept = d.decisions.filter(x => x.include)
  const trimmed = kept.filter(x => x.trim)
  const byId = new Map(d.stats.map(s => [s.id, s]))
  const keptSec = kept.reduce((a, x) => a + (x.trim ? x.trim[1] - x.trim[0] : byId.get(x.id)!.duration), 0)
  const totalSec = d.stats.reduce((a, s) => a + s.duration, 0)
  const reasons = new Map<string, number>()
  for (const x of d.decisions) if (!x.include) for (const r of x.reasons) reasons.set(r, (reasons.get(r) ?? 0) + 1)
  const json = useMemo(() => JSON.stringify(decisionsJson(d.stats, d.decisions, rules), null, 1), [d.stats, d.decisions, rules])
  const name = slug(project.name)
  const overrides = Object.entries(project.overrides)
  const snippet = `import json
from lerobot.common.datasets.lerobot_dataset import LeRobotDataset

curated = json.load(open("${name}-curated.json"))
# episode ids like "ep_012" or "12" -> LeRobot integer episode_index
keep = [int(str(x["episode_id"]).split("_")[-1]) for x in curated["episodes"]]
trims = {x["episode_id"]: x["trim_frames"] for x in curated["episodes"] if x["trim_frames"]}

ds = LeRobotDataset("your-org/your-dataset", episodes=keep)
# Apply trims in your sampler: drop frames outside trims[episode_id] = [first, last]`

  return (
    <>
      <div className="kpis">
        <div className="kpi"><small>Kept</small><b>{kept.length}</b><p>of {d.stats.length} episodes</p></div>
        <div className="kpi"><small>Excluded</small><b>{d.stats.length - kept.length}</b><p>{overrides.length} manual overrides</p></div>
        <div className="kpi"><small>Trimmed</small><b>{trimmed.length}</b><p>{fmtS(kept.reduce((a, x) => a + (x.trim ? byId.get(x.id)!.duration - (x.trim[1] - x.trim[0]) : 0), 0))} of idle removed</p></div>
        <div className="kpi"><small>Training time</small><b>{fmtS(keptSec)}</b><p>{fmtPct(keptSec / totalSec)} of recorded</p></div>
      </div>
      <div className="panel">
        <div className="panel-head"><h2>Curation rules</h2><span className="muted small">Always-keep beats exclude; manual overrides beat both. Trim applies to kept episodes.</span></div>
        <div className="rules">
          {rules.map(r => {
            const meta = FIELD_META[r.field]
            return (
              <div key={r.id} className={`rule${r.enabled ? '' : ' off'}`}>
                <span className="switch"><input type="checkbox" checked={r.enabled} aria-label={`Enable: ${describeRule(r)}`} onChange={e => patch(r.id, { enabled: e.target.checked }, `${e.target.checked ? 'Enabled' : 'Disabled'} rule: ${describeRule(r)}`)} /><span /></span>
                <select aria-label="Action" value={r.action} onChange={e => patch(r.id, { action: e.target.value as RuleAction })}>{ACTIONS.map(([a, l]) => <option key={a} value={a}>{l}</option>)}</select>
                <span className="muted small">when</span>
                <select aria-label="Field" value={r.field} onChange={e => { const f = e.target.value as RuleField; patch(r.id, { field: f, op: FIELD_META[f].kind === 'num' ? '<' : '=', value: FIELD_META[f].kind === 'bool' ? 'true' : FIELD_META[f].kind === 'num' ? '0' : '' }) }}>{(Object.keys(FIELD_META) as RuleField[]).map(f => <option key={f} value={f}>{FIELD_META[f].label}</option>)}</select>
                <select aria-label="Operator" value={r.op} onChange={e => patch(r.id, { op: e.target.value as RuleOp })}>{(meta.kind === 'num' ? OPS : ['=', '!='] as RuleOp[]).map(o => <option key={o} value={o}>{o === '!=' ? '≠' : o}</option>)}</select>
                {meta.kind === 'bool'
                  ? <select aria-label="Value" value={/^(true|1|yes|success)$/i.test(r.value) ? 'true' : 'false'} onChange={e => patch(r.id, { value: e.target.value })}><option value="true">{r.field === 'success' ? 'success' : 'true'}</option><option value="false">{r.field === 'success' ? 'failure' : 'false'}</option></select>
                  : <input aria-label="Value" defaultValue={r.value} key={r.id + r.field} list={`vals-${r.field}`} onBlur={e => { if (e.target.value !== r.value) patch(r.id, { value: e.target.value.trim() }) }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />}
                <span className="muted tiny">{meta.unit ?? (meta.pct ? '%' : '')}</span>
                <span className="rule-hits tiny muted">{r.enabled ? `${d.stats.filter(s => matches(s, r, d.ctx)).length} match` : 'off'}</span>
                <button type="button" className="icon-btn" aria-label={`Remove rule: ${describeRule(r)}`} onClick={() => setRules(rules.filter(x => x.id !== r.id), `Removed rule: ${describeRule(r)}`)}>&times;</button>
              </div>
            )
          })}
        </div>
        <datalist id="vals-operator">{[...new Set(d.stats.map(s => s.operator))].map(v => <option key={v} value={v} />)}</datalist>
        <datalist id="vals-task">{[...new Set(d.stats.map(s => s.task))].map(v => <option key={v} value={v} />)}</datalist>
        <datalist id="vals-tag">{[...new Set(d.stats.flatMap(s => s.tags))].map(v => <option key={v} value={v} />)}</datalist>
        <div className="row gap-sm wrap" style={{ marginTop: 12 }}>
          <button type="button" className="btn sm outline" onClick={() => { const r: Rule = { id: uuid(), field: 'score', op: '<', value: '60', action: 'exclude', enabled: true }; setRules([...rules, r], `Added rule: ${describeRule(r)}`) }}>Add rule</button>
          {reasons.size > 0 && <span className="muted small">Excluded by: {[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r.replace(/^Exclude episodes where /, '')} (${n})`).join(' · ')}</span>}
        </div>
      </div>
      {overrides.length > 0 && (
        <div className="panel">
          <div className="panel-head"><h2>Manual overrides</h2><button type="button" className="btn sm ghost" onClick={() => { const before = project.overrides; void update({ overrides: {} }, 'Cleared all manual overrides'); toast('Overrides cleared', { undo: () => void update({ overrides: before }) }) }}>Clear all</button></div>
          <div className="row gap-sm wrap">{overrides.map(([id, o]) => <span key={id} className="chip"><Link href={epHref(project.id, id)} className="mono">{id}</Link> {o === 'keep' ? 'kept' : 'excluded'}</span>)}</div>
        </div>
      )}
      <div className="panel">
        <div className="panel-head"><h2>Export the curated set</h2><span className="muted small">Trim ranges in seconds and frame indices, per episode</span></div>
        <div className="row gap wrap">
          <button type="button" className="btn primary" onClick={() => download(`${name}-curated.csv`, decisionsCsv(d.stats, d.decisions))}>Download CSV</button>
          <button type="button" className="btn outline" onClick={() => download(`${name}-curated.json`, json, 'application/json')}>Download JSON</button>
          <CopyButton text={kept.map(x => x.id).join('\n')} label="Copy kept ids" />
          <Link href={`/app/p/${project.id}/report`} className="btn ghost">Quality report</Link>
        </div>
        <Code label="Python: load the kept episodes (LeRobot)" code={snippet} />
      </div>
    </>
  )
}


// ---------------- History ----------------

function History({ project, update }: TabProps) {
  const vs = project.versions
  const [a, setA] = useState(vs.at(-2)?.id ?? '')
  const [b, setB] = useState(vs.at(-1)?.id ?? '')
  const va = vs.find(v => v.id === a), vb = vs.find(v => v.id === b)
  const diff = va && vb ? diffVersions(va, vb) : null
  const del = async (id: string) => {
    const v = vs.find(x => x.id === id)!
    if (!(await ask(`Delete “${v.label}”?`, 'Removes this version from the history. The current dataset and rules are not affected.', 'Delete version'))) return
    const before = project
    await saveProject({ ...project, versions: vs.filter(x => x.id !== id) })
    void deleteVersionCloud(id)
    toast('Version deleted', { undo: () => void saveProject(before) })
  }
  const sign = (n: number, d = 0) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toFixed(d)}`
  return (
    <>
      <div className="panel">
        <div className="panel-head"><h2>Versions</h2><span className="muted small">One per import, plus any you save (V). Each records the episode set, the rules and what they kept.</span></div>
        {vs.length === 0 ? <Empty title="No versions yet"><p className="muted small">Import data or press Save version.</p></Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Version</th><th>When</th><th>Kind</th><th className="num">Episodes</th><th className="num">Kept</th><th className="num">Mean score</th><th className="num">Rules</th><th>Compare</th><th /></tr></thead>
            <tbody>{[...vs].reverse().map(v => (
              <tr key={v.id}>
                <th scope="row">{v.label}</th><td className="small">{new Date(v.at).toLocaleString()}</td><td><span className="badge">{v.kind}</span></td>
                <td className="num">{v.episodes}</td><td className="num">{v.kept}</td><td className="num">{v.meanScore.toFixed(1)}</td><td className="num">{v.rules.filter(r => r.enabled).length}</td>
                <td><div className="row gap-sm"><label className="tiny"><input type="radio" name="va" checked={a === v.id} onChange={() => setA(v.id)} /> A</label><label className="tiny"><input type="radio" name="vb" checked={b === v.id} onChange={() => setB(v.id)} /> B</label></div></td>
                <td><button type="button" className="icon-btn" aria-label={`Delete ${v.label}`} onClick={() => void del(v.id)}>&times;</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {diff && va && vb && va.id !== vb.id && (
        <div className="panel">
          <div className="panel-head"><h2>{va.label} → {vb.label}</h2></div>
          <div className="kpis">
            <div className="kpi"><small>Episodes</small><b>{vb.episodes}</b><p>{sign(vb.episodes - va.episodes)} ({diff.episodesAdded.length} added, {diff.episodesRemoved.length} removed)</p></div>
            <div className="kpi"><small>Kept</small><b>{vb.kept}</b><p>{sign(vb.kept - va.kept)}</p></div>
            <div className="kpi"><small>Mean score</small><b>{vb.meanScore.toFixed(1)}</b><p>{sign(vb.meanScore - va.meanScore, 1)}</p></div>
            <div className="kpi"><small>Recorded</small><b>{fmtS(vb.hours * 3600)}</b><p>{sign((vb.hours - va.hours) * 3600, 0)} s</p></div>
          </div>
          <div className="grid-2">
            <div>
              <h3 className="small strong">Rule changes</h3>
              <ul className="small diff-list">
                {diff.rulesAdded.map(r => <li key={r.id} className="add">Added: {describeRule(r)}{r.enabled ? '' : ' (off)'}</li>)}
                {diff.rulesRemoved.map(r => <li key={r.id} className="rem">Removed: {describeRule(r)}</li>)}
                {diff.rulesChanged.map(c => <li key={c.after.id} className="chg">{describeRule(c.before)}{c.before.enabled ? '' : ' (off)'} → {describeRule(c.after)}{c.after.enabled ? '' : ' (off)'}</li>)}
                {!diff.rulesAdded.length && !diff.rulesRemoved.length && !diff.rulesChanged.length && <li className="muted">No rule changes</li>}
              </ul>
              <h3 className="small strong">Issue counts</h3>
              <ul className="small diff-list">{KINDS.filter(k => (va.issueCounts[k] ?? 0) || (vb.issueCounts[k] ?? 0)).map(k => <li key={k}>{KIND_LABEL[k]}: {va.issueCounts[k] ?? 0} → {vb.issueCounts[k] ?? 0}</li>)}</ul>
            </div>
            <div>
              <h3 className="small strong">Now excluded ({diff.nowExcluded.length})</h3>
              <p className="small mono break">{diff.nowExcluded.slice(0, 40).map(id => <Link key={id} href={epHref(project.id, id)}>{id} </Link>)}{diff.nowExcluded.length > 40 ? `and ${diff.nowExcluded.length - 40} more` : diff.nowExcluded.length ? '' : <span className="muted">none</span>}</p>
              <h3 className="small strong">Now included ({diff.nowIncluded.length})</h3>
              <p className="small mono break">{diff.nowIncluded.slice(0, 40).map(id => <Link key={id} href={epHref(project.id, id)}>{id} </Link>)}{diff.nowIncluded.length > 40 ? `and ${diff.nowIncluded.length - 40} more` : diff.nowIncluded.length ? '' : <span className="muted">none</span>}</p>
              {diff.episodesAdded.length > 0 && <><h3 className="small strong">New episodes ({diff.episodesAdded.length})</h3><p className="small mono break">{diff.episodesAdded.slice(0, 40).join(' ')}</p></>}
            </div>
          </div>
        </div>
      )}
      <div className="panel">
        <div className="panel-head"><h2>Change log</h2><span className="muted small">Imports, rule edits, overrides and tags</span></div>
        {project.log.length === 0 ? <p className="muted small">Nothing yet.</p> : (
          <ol className="timeline">{[...project.log].reverse().slice(0, 200).map((l, i) => <li key={i}><span className="mono tiny muted">{new Date(l.at).toLocaleString()}</span><span>{l.text}</span></li>)}</ol>
        )}
        <div className="row gap-sm"><button type="button" className="btn sm ghost" onClick={() => go(`/app/p/${project.id}/curate`)}>Edit rules</button>{project.log.length > 0 && <button type="button" className="btn sm ghost" onClick={() => { const before = project.log; void update({ log: [] }); toast('Log cleared', { undo: () => void update({ log: before }) }) }}>Clear log</button>}</div>
      </div>
    </>
  )
}
