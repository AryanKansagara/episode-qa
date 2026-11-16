import { useMemo } from 'react'
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

export function ConfigEditor({ cfg, onChange, eps = [] }: { cfg: Config; onChange(c: Config): void; eps?: Episode[] }) {
  const nJ = eps[0]?.q[0]?.length ?? 0
  const jerkFit = useMemo(() => suggestJerkLimit(eps), [eps])
  const fitJoints = () => onChange({ ...cfg, limits: Array.from({ length: nJ }, (_, i) => cfg.limits[i] ?? { name: `j${i + 1}`, min: -3.14, max: 3.14, vel: 3.14 }) })
  const setTh = (k: keyof Thresholds, v: number) => { if (Number.isFinite(v) && v >= 0) onChange({ ...cfg, th: { ...cfg.th, [k]: v } }) }
  const setL = (i: number, patch: Partial<JointLimit>) => onChange({ ...cfg, limits: cfg.limits.map((l, j) => j === i ? { ...l, ...patch } : l) })
  return (
    <>
      <h3 className="small strong">Joint limits</h3>
      <p className="muted small">From your arm&rsquo;s datasheet, in radians and rad/s, in the same order as your joint columns. The defaults are a generic 7-DoF arm; replace them.</p>
      {nJ > 0 && nJ !== cfg.limits.length && (
        <div className="banner warn"><span><strong>Limits cover {cfg.limits.length} joints, the data has {nJ}.</strong> Saturation is skipped until they match.</span>
          <button type="button" className="btn sm" onClick={fitJoints}>Use {nJ} joints</button></div>
      )}
      <div className="table-wrap">
        <table className="limits">
          <thead><tr><th>Joint</th><th>Min (rad)</th><th>Max (rad)</th><th>Max speed (rad/s)</th><th /></tr></thead>
          <tbody>{cfg.limits.map((l, i) => (
            <tr key={i}>
              <td><input className="table-input" value={l.name} aria-label={`Name of joint ${i + 1}`} onChange={e => setL(i, { name: e.target.value })} /></td>
              <td><input className="table-input" type="number" step="0.01" value={l.min} aria-label={`${l.name} minimum`} onChange={e => setL(i, { min: Number(e.target.value) })} /></td>
              <td><input className="table-input" type="number" step="0.01" value={l.max} aria-label={`${l.name} maximum`} onChange={e => setL(i, { max: Number(e.target.value) })} /></td>
              <td><input className="table-input" type="number" step="0.01" min="0" value={l.vel} aria-label={`${l.name} max speed`} onChange={e => setL(i, { vel: Number(e.target.value) })} /></td>
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
            <input type="number" min="0" step={step} value={cfg.th[k]} onChange={e => setTh(k, Number(e.target.value))} />
            <small className="muted tiny">{hint}{cfg.th[k] !== DEFAULT_TH[k] ? ` · default ${DEFAULT_TH[k]}` : ''}
              {k === 'jerkLimit' && jerkFit !== null && jerkFit !== cfg.th.jerkLimit && <> · <button type="button" className="linkish" onClick={() => setTh('jerkLimit', jerkFit)}>fit to this data: {jerkFit}</button></>}</small>
          </label>
        ))}
      </div>
    </>
  )
}
