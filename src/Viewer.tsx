import { useEffect, useMemo, useRef, useState } from 'react'
import { analyzeEpisode, PENALTY_LABELS, sliceEpisode } from './engine/analyze.ts'
import type { Config, Episode, IssueKind } from './engine/types.ts'

export const KIND_LABEL: Record<IssueKind, string> = { drop: 'Dropped frames', sync: 'Sync drift', jerk: 'Jerk', saturation: 'Saturation', idle: 'Idle', grasp: 'Failed grasp', label: 'Label mismatch' }
export const KINDS = Object.keys(KIND_LABEL) as IssueKind[]

const W = 640, H = 250
const PX = 34, PW = W - PX - 8
const JT = 10, JH = 128, GT = 148, GH = 26, LT = 186, LH = 18

function thin<T>(a: T[], n: number): [T, number][] {
  const step = Math.max(1, Math.ceil(a.length / n))
  const out: [T, number][] = []
  for (let i = 0; i < a.length; i += step) out.push([a[i], i])
  if (out.at(-1)?.[1] !== a.length - 1 && a.length) out.push([a[a.length - 1], a.length - 1])
  return out
}

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function ScoreRing({ score, size = 'md' }: { score: number; size?: 'md' | 'lg' }) {
  const tone = score >= 85 ? 'var(--good)' : score >= 70 ? 'var(--phoenix)' : 'var(--bad)'
  return <div className={`score-ring ${size}`} style={{ ['--s' as string]: score, ['--ring' as string]: tone }} role="img" aria-label={`Quality score ${score} of 100`}><span>{score}</span></div>
}

export function Viewer({ ep, cfg, autoplay = false, speed = 1.6, title }: { ep: Episode; cfg: Config; autoplay?: boolean; speed?: number; title?: string }) {
  const t0 = ep.t[0] ?? 0, tN = ep.t.at(-1) ?? 0
  const [t, setT] = useState(() => autoplay && !reduced() ? t0 : tN)
  const [playing, setPlaying] = useState(autoplay && !reduced())
  const raf = useRef(0)
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => { setT(autoplay && !reduced() ? t0 : tN); setPlaying(autoplay && !reduced()) }, [ep])

  // Pause the autoplaying hero when it scrolls out of view.
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    if (!host.current || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting))
    io.observe(host.current)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!playing || !visible) return
    let last = performance.now(), hold = 0
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      setT(cur => {
        if (cur >= tN) {
          if (!autoplay) { setPlaying(false); return tN }
          hold += dt
          return hold > 2.2 ? (hold = 0, t0) : tN
        }
        return Math.min(tN, cur + dt * speed)
      })
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [playing, visible, tN, t0, autoplay, speed])

  const k = Math.max(0, ep.t.findIndex(x => x > t) === -1 ? ep.t.length - 1 : ep.t.findIndex(x => x > t) - 1)
  const live = useMemo(() => analyzeEpisode(k >= ep.t.length - 1 ? ep : sliceEpisode(ep, ep.t[k]), cfg), [ep, cfg, k])

  // Geometry
  const nJ = ep.q[0]?.length ?? 0
  const ranges = useMemo(() => Array.from({ length: nJ }, (_, j) => { let lo = Infinity, hi = -Infinity; for (const r of ep.q) { lo = Math.min(lo, r[j]); hi = Math.max(hi, r[j]) } return [lo, hi === lo ? lo + 1 : hi] }), [ep])
  const X = (x: number) => PX + ((x - t0) / Math.max(1e-6, tN - t0)) * PW
  const jointPaths = useMemo(() => ranges.map(([lo, hi], j) => thin(ep.q, 320).map(([r, i]) => `${X(ep.t[i]).toFixed(1)},${(JT + JH - ((r[j] - lo) / (hi - lo)) * JH).toFixed(1)}`).join(' ')), [ep, ranges])
  const gripPath = useMemo(() => ep.grip ? `M${PX},${GT + GH} ` + thin(ep.grip, 240).map(([g, i]) => `L${X(ep.t[i]).toFixed(1)},${(GT + GH - g * GH).toFixed(1)}`).join(' ') + ` L${PX + PW},${GT + GH} Z` : '', [ep])

  const path = ep.ee ?? ep.q.map(r => r.slice(0, 2))
  const bounds = useMemo(() => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const p of path) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]) }
    const s = Math.max(x1 - x0, y1 - y0) * 1.15 || 1
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, s }
  }, [ep])
  // Top-down view: robot x forward (up the screen), y left.
  const TP = (p: number[]) => [130 + ((bounds.cy - p[1]) / bounds.s) * 220, 130 - ((p[0] - bounds.cx) / bounds.s) * 220]
  const full = useMemo(() => thin(path, 400).map(([p]) => TP(p).map(v => v.toFixed(1)).join(',')).join(' '), [ep, bounds])
  const done = thin(path.slice(0, k + 1), 400).map(([p]) => TP(p).map(v => v.toFixed(1)).join(',')).join(' ')
  const closedSegs = useMemo(() => {
    if (!ep.gripCmd) return [] as string[]
    const segs: string[] = []
    let cur: string[] = []
    ep.gripCmd.forEach((c, i) => { if (c >= 0.5) cur.push(TP(path[i]).map(v => v.toFixed(1)).join(',')); else if (cur.length) { segs.push(cur.join(' ')); cur = [] } })
    if (cur.length) segs.push(cur.join(' '))
    return segs
  }, [ep, bounds])
  const pos = TP(path[k] ?? path[0])
  const frameAt = (x: number) => { const i = ep.t.findIndex(v => v >= x); return i === -1 ? ep.t.length - 1 : i }

  const counts = KINDS.map(kd => [kd, live.issues.filter(i => i.kind === kd).length] as const)
  const feed = live.issues.slice(-4).reverse()
  const closed = ep.gripCmd ? ep.gripCmd[k] >= 0.5 : false

  const scrubFromPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * W
    setT(Math.min(tN, Math.max(t0, t0 + ((x - PX) / PW) * (tN - t0))))
    setPlaying(false)
  }

  return (
    <div className="viewer" ref={host}>
      <div className="viewer-top">
        <ScoreRing score={live.score} size="lg" />
        <div className="viewer-title">
          <b>{title ?? ep.id}</b>
          <small className="mono">{ep.task} · {ep.operator} · {nJ}-DoF · {Object.keys(ep.cams).length} cams · {live.joints.hz ? live.joints.hz.toFixed(0) : '—'} Hz</small>
        </div>
        <div className="viewer-chips" aria-label="Issues found so far">
          {counts.filter(([, n]) => n > 0).map(([kd, n]) => <span key={kd} className="kchip" style={{ ['--k' as string]: `var(--k-${kd})` }}><i />{KIND_LABEL[kd]} <b>{n}</b></span>)}
          {counts.every(([, n]) => n === 0) && <span className="kchip clean"><i />No issues yet</span>}
        </div>
      </div>
      <div className="viewer-grid">
        <svg className="traj" viewBox="0 0 260 260" role="img" aria-label="Top-down end-effector path">
          <defs><pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--line)" /></pattern></defs>
          <rect width="260" height="260" rx="12" fill="var(--plot-bg)" />
          <rect width="260" height="260" rx="12" fill="url(#dots)" />
          <polyline points={full} fill="none" stroke="var(--border)" strokeWidth="1.5" strokeDasharray="3 4" />
          <polyline points={done} fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {closedSegs.map((s, i) => <polyline key={i} points={s} fill="none" stroke="var(--phoenix)" strokeWidth="4" strokeLinecap="round" opacity=".55" />)}
          {live.issues.map((iss, i) => { const p = TP(path[frameAt(iss.t)] ?? path[0]); return <g key={i} className="pin" transform={`translate(${p[0].toFixed(1)} ${p[1].toFixed(1)})`}><rect x="-5" y="-5" width="10" height="10" rx="2" transform="rotate(45)" fill={`var(--k-${iss.kind})`} stroke="var(--surface)" strokeWidth="1.5" /></g> })}
          <circle cx={pos[0]} cy={pos[1]} r={closed ? 8 : 6} fill={closed ? 'var(--phoenix)' : 'var(--surface)'} stroke="var(--ink)" strokeWidth="2" />
          <text x="12" y="248" className="svg-label">top-down · {ep.ee ? 'end-effector' : 'joints 1-2'}</text>
        </svg>
        <svg className="plot" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Joint positions, gripper opening and detected issues over time" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); scrubFromPointer(e) }} onPointerMove={e => { if (e.buttons) scrubFromPointer(e) }}>
          <rect x={PX} y={JT - 4} width={PW} height={JH + 8} rx="6" fill="var(--plot-bg)" />
          {jointPaths.map((d, j) => <polyline key={j} points={d} fill="none" stroke={`var(--j${j % 7})`} strokeWidth="1.4" opacity={live.satJoints.includes(j) ? 1 : 0.85} />)}
          {gripPath && <path d={gripPath} fill="color-mix(in srgb, var(--phoenix) 30%, transparent)" stroke="var(--phoenix)" strokeWidth="1" />}
          <text x="2" y={JT + 10} className="svg-label">joints</text>
          <text x="2" y={GT + 16} className="svg-label">grip</text>
          <text x="2" y={LT + 13} className="svg-label">issues</text>
          <rect x={PX} y={LT} width={PW} height={LH} rx="4" fill="var(--plot-bg)" />
          {live.issues.map((iss, i) => {
            const x1 = X(iss.t), x2 = iss.t2 !== undefined ? Math.max(X(iss.t2), x1 + 3) : x1 + 3
            return <rect key={i} className="lane-mark" x={x1} y={LT + 2} width={x2 - x1} height={LH - 4} rx="2" fill={`var(--k-${iss.kind})`}><title>{`${iss.t.toFixed(2)} s · ${iss.msg}`}</title></rect>
          })}
          <rect x={X(t)} y={JT - 4} width={PX + PW - X(t)} height={LT + LH - JT + 4} fill="var(--surface)" opacity=".55" pointerEvents="none" />
          <line x1={X(t)} x2={X(t)} y1={JT - 6} y2={LT + LH + 4} stroke="var(--ink)" strokeWidth="1.5" />
          <circle cx={X(t)} cy={JT - 6} r="4" fill="var(--phoenix)" />
          {[0, 0.25, 0.5, 0.75, 1].map(f => <text key={f} x={PX + f * PW} y={H - 6} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'} className="svg-label">{(t0 + f * (tN - t0)).toFixed(1)} s</text>)}
        </svg>
      </div>
      <div className="viewer-controls">
        <button type="button" className="icon-btn play" aria-label={playing ? 'Pause' : 'Play'} onClick={() => { if (!playing && t >= tN) setT(t0); setPlaying(p => !p) }}>
          {playing ? <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
            : <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z" /></svg>}
        </button>
        <input type="range" min={t0} max={tN} step={0.01} value={t} aria-label="Scrub through the episode" onChange={e => { setT(Number(e.target.value)); setPlaying(false) }} />
        <span className="mono tiny tab-nums">{(t - t0).toFixed(2)} / {(tN - t0).toFixed(2)} s · frame {k}</span>
      </div>
      <ol className="feed" aria-live="polite">
        {feed.length === 0 && <li className="muted">Scrub or press play. Issues appear here as the playhead reaches them.</li>}
        {feed.map((iss, i) => <li key={`${iss.kind}-${iss.t}-${i}`}><i style={{ background: `var(--k-${iss.kind})` }} /><span className="mono tab-nums">{iss.t.toFixed(2)} s</span><span>{iss.msg}</span></li>)}
      </ol>
      <div className="penalties">
        {Object.entries(live.penalties).filter(([, v]) => v > 0.05).map(([kk, v]) => <span key={kk}>{PENALTY_LABELS[kk]} <b>−{v.toFixed(1)}</b></span>)}
      </div>
    </div>
  )
}
