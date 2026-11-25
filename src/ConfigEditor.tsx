import { useMemo, useState, type InputHTMLAttributes } from 'react'
import { DEFAULT_LIMITS, DEFAULT_TH, suggestJerkLimit } from './engine/analyze.ts'
import type { Config, Episode, JointLimit, Thresholds } from './engine/types.ts'

const TH_FIELDS: [keyof Thresholds, string, string, number][] = [
  ['dropFactor', 'Drop gap (× median period)', 'A gap longer than this counts as dropped frames', 0.1],
  ['offsetWarnMs', 'Camera offset warning (ms)', 'Flag a camera further than this from the joint clock', 1],
  ['jerkLimit', 'Jerk spike (rad/s³)', 'Third-difference jerk on commanded targets', 10],
  ['satMargin', 'Limit margin (fraction of range)', '0.01 = within 1% of a joint limit', 0.005],
  ['idleSpeed', 'Idle speed (rad/s)', 'Every joint slower than this counts as still', 0.005],
  ['idleMinSec', 'Minimum idle (s)', 'Shorter pauses are ignored', 0.1],
  ['settleSec', 'Grasp settle time (s)', 'When the grasp is judged after the close command', 0.05],
  ['emptyGrip', 'Empty gripper opening (0-1)', 'Below this the fingers closed on nothing', 0.01],
  ['dupDist', 'Duplicate distance (m)', 'Mean DTW step distance between end-effector paths', 0.001],
]

/** A number input that keeps the last valid value while its text is blank or not usable, and says so. */
function NumField({ value, min, onChange, ...rest }: { value: number; min?: number; onChange(v: number): void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'min' | 'onChange'>) {
  const [draft, setDraft] = useState<string | null>(null)
  const [kept, setKept] = useState<'blank' | 'invalid' | null>(null)
  const edit = (s: string) => {
    const v = Number(s)
    const bad = s.trim() === '' ? 'blank' : !Number.isFinite(v) || (min !== undefined && v < min) ? 'invalid' : null
    setDraft(s)
    setKept(bad)
    if (!bad) onChange(v)
  }
  return (
    <>
      <input {...rest} type="number" min={min} value={kept || (draft !== null && Number(draft) === value) ? draft ?? value : value} aria-invalid={kept ? true : undefined}
        onChange={e => edit(e.target.value)} onBlur={() => setDraft(null)} />
      {kept && <small className="error tiny" role="alert">{kept === 'blank' ? 'Blank' : 'Not a usable number'}: still {value}</small>}
    </>
  )
}

export function ConfigEditor({ cfg, onChange, eps = [] }: { cfg: Config; onChange(c: Config): void; eps?: Episode[] }) {
  const nJ = eps[0]?.q[0]?.length ?? 0
  const jerkFit = useMemo(() => suggestJerkLimit(eps), [eps])
  // Untouched generic 7-DoF limits do not describe another arm, so start from open placeholders; entered limits are kept.
  const generic = JSON.stringify(cfg.limits) === JSON.stringify(DEFAULT_LIMITS)
  const fitJoints = () => onChange({ ...cfg, limits: Array.from({ length: nJ }, (_, i) => (!generic && cfg.limits[i]) || { name: `j${i + 1}`, min: -3.14, max: 3.14, vel: 3.14 }) })
  const setTh = (k: keyof Thresholds, v: number) => onChange({ ...cfg, th: { ...cfg.th, [k]: v } })
  const setL = (i: number, patch: Partial<JointLimit>) => onChange({ ...cfg, limits: cfg.limits.map((l, j) => j === i ? { ...l, ...patch } : l) })
  return (
    <>
      <h3 className="small strong">Joint limits</h3>
      <p className="muted small">From your arm&rsquo;s datasheet, in radians and rad/s, in the same order as your joint columns. The defaults are a generic 7-DoF arm; replace them.</p>
      {nJ > 0 && nJ !== cfg.limits.length && (
        <div className="banner warn"><span><strong>Limits cover {cfg.limits.length} joints, the data has {nJ}.</strong> Saturation is skipped until they match. {generic ? 'The generic 7-DoF limits are replaced with open ±3.14 rad placeholders; enter your arm\u2019s values.' : 'Your entered limits are kept.'}</span>
          <button type="button" className="btn sm" onClick={fitJoints}>Use {nJ} joints</button></div>
      )}
      <div className="table-wrap">
        <table className="limits">
          <thead><tr><th>Joint</th><th>Min (rad)</th><th>Max (rad)</th><th>Max speed (rad/s)</th><th /></tr></thead>
          <tbody>{cfg.limits.map((l, i) => (
            <tr key={i}>
              <td><input className="table-input" value={l.name} aria-label={`Name of joint ${i + 1}`} onChange={e => setL(i, { name: e.target.value })} /></td>
              <td><NumField className="table-input" step="0.01" value={l.min} aria-label={`${l.name} minimum`} onChange={v => setL(i, { min: v })} /></td>
              <td><NumField className="table-input" step="0.01" value={l.max} aria-label={`${l.name} maximum`} onChange={v => setL(i, { max: v })} /></td>
              <td><NumField className="table-input" step="0.01" min={0} value={l.vel} aria-label={`${l.name} max speed`} onChange={v => setL(i, { vel: v })} /></td>
              <td><button type="button" className="icon-btn" aria-label={`Remove ${l.name}`} onClick={() => onChange({ ...cfg, limits: cfg.limits.filter((_, j) => j !== i) })}>&times;</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="row gap-sm wrap" style={{ margin: '10px 0 20px' }}>
        <button type="button" className="btn sm ghost" onClick={() => onChange({ ...cfg, limits: [...cfg.limits, { name: `j${cfg.limits.length + 1}`, min: -3.14, max: 3.14, vel: 2 }] })}>Add joint</button>
        <button type="button" className="btn sm ghost" onClick={() => onChange({ ...cfg, limits: DEFAULT_LIMITS.map(l => ({ ...l })) })}>Reset to generic 7-DoF</button>
      </div>
      <h3 className="small strong">Thresholds</h3>
      <div className="inline-fields wide">
        {TH_FIELDS.map(([k, label, hint, step]) => (
          <label key={k} className="field" title={hint}><span>{label}</span>
            <NumField min={0} step={step} value={cfg.th[k]} onChange={v => setTh(k, v)} />
            <small className="muted tiny">{hint}{cfg.th[k] !== DEFAULT_TH[k] ? ` · default ${DEFAULT_TH[k]}` : ''}
              {k === 'jerkLimit' && jerkFit !== null && jerkFit !== cfg.th.jerkLimit && <> · <button type="button" className="linkish" onClick={() => setTh('jerkLimit', jerkFit)}>fit to this data: {jerkFit}</button></>}</small>
          </label>
        ))}
      </div>
    </>
  )
}
