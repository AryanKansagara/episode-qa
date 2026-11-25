import { useEffect, useState } from 'react'
import { SAMPLE_NAME } from './engine/sample.ts'
import { createBlankProject, createSampleProject, fmtS } from './projectData.ts'
import { deleteProject, saveProject, useProjects, type Project } from './store.ts'
import { useSync } from './sync.ts'
import { ask, fmtN, go, Link, SyntheticBadge, toast } from './ui.tsx'

export default function Workspace() {
  const list = useProjects()
  const sync = useSync()
  const [busy, setBusy] = useState<string | null>(null)

  // /app?sample=1 opens (or creates) the sample straight away.
  useEffect(() => {
    const q = new URLSearchParams(location.search)
    const tab = q.get('tab')?.replace(/[^a-z]/g, '')
    if (!q.get('sample') || list === null || busy) return
    setBusy('sample')
    const ep = q.get('ep')
    void createSampleProject().then(p => go(`/app/p/${p.id}${tab ? '/' + tab : ''}${ep ? `?ep=${encodeURIComponent(ep)}` : ''}`, { replace: true }))
  }, [list, busy])

  const openSample = async () => { setBusy('sample'); const p = await createSampleProject(); go(`/app/p/${p.id}`) }
  const newProject = async () => {
    const name = `Dataset ${(list?.filter(p => !p.sampleId).length ?? 0) + 1}`
    const p = await createBlankProject(name)
    go(`/app/p/${p.id}/data`)
  }

  if (list === null || busy) return <div className="boot" role="status"><span className="spinner" /> {busy ? 'Generating 120 synthetic episodes' : 'Opening your datasets'}</div>

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1>Datasets</h1>
          <p className="muted">One workspace per collection campaign. Each keeps its joint limits, thresholds, curation rules, tags and versions. {sync.user ? 'Synced to your account.' : 'Stored on this device.'}</p>
        </div>
        {list.length > 0 && <div className="row gap"><button type="button" className="btn primary" onClick={newProject}>New dataset</button></div>}
      </div>

      {list.length === 0 ? (
        <div className="onboard">
          <article className="onboard-card feature-card">
            <div className="eyebrow">Two minutes</div>
            <h2>Try the sample</h2>
            <p>A synthetic week of pick-and-place teleop with planted problems: a camera clock that drifts on one rig, an operator who idles and snaps the controller, another whose grasps slip, re-exported duplicates. Everything is clickable.</p>
            <button type="button" className="sample-btn" onClick={() => void openSample()}>
              <span><strong>{SAMPLE_NAME}</strong><small>120 episodes · 3 operators · 7-DoF arm + gripper · wrist and head cameras</small></span><span aria-hidden="true">&rarr;</span>
            </button>
          </article>
          <article className="onboard-card">
            <div className="eyebrow">Your episodes</div>
            <h2>Import your data</h2>
            <p>Drop per-frame CSV or JSONL (LeRobot exports work), episode metadata, camera timestamps or a ROS bag CSV. The format is detected, columns are mapped, and every bad row is reported with its line number.</p>
            <div className="row gap wrap">
              <button type="button" className="btn primary" onClick={newProject}>Import your data</button>
              <Link href="/docs" className="btn ghost">Export guides</Link>
            </div>
            <p className="muted small">Files are parsed in your browser and stay on this device unless you sign in to sync.</p>
          </article>
        </div>
      ) : (
        <>
          <div className="project-grid">
            {list.map(p => <ProjectCard key={p.id} p={p} />)}
          </div>
          <div className="samples-row">
            <span className="muted small">Sample:</span>
            <button type="button" className="linkish small" onClick={() => void openSample()}>{SAMPLE_NAME}</button>
          </div>
        </>
      )}
    </section>
  )
}

function ProjectCard({ p }: { p: Project }) {
  const [renaming, setRenaming] = useState(false)
  const n = p.stats.length
  const mean = n ? Math.round(p.stats.reduce((a, s) => a + s.score, 0) / n) : null
  const last = p.versions.at(-1)
  return (
    <article className="project-card">
      <div className="row between">
        {renaming ? (
          <form onSubmit={e => { e.preventDefault(); const v = String(new FormData(e.currentTarget).get('n')).trim(); if (v) void saveProject({ ...p, name: v }); setRenaming(false) }}>
            <input name="n" defaultValue={p.name} autoFocus aria-label="Dataset name" onBlur={e => e.currentTarget.form?.requestSubmit()} />
          </form>
        ) : <h3><Link href={`/app/p/${p.id}`}>{p.name}</Link></h3>}
        {p.sampleId && <SyntheticBadge />}
      </div>
      <dl className="mini-stats">
        <div><dt>Episodes</dt><dd>{fmtN(n)}</dd></div>
        <div><dt>Recorded</dt><dd>{n ? fmtS(p.stats.reduce((a, s) => a + s.duration, 0)) : '—'}</dd></div>
        <div><dt>Mean score</dt><dd>{mean ?? '—'}</dd></div>
        <div><dt>Kept</dt><dd>{last ? `${last.kept}/${last.episodes}` : '—'}</dd></div>
      </dl>
      {p.dataMissing && <p className="warn-text small">Raw frames live on another device. Curation works; re-import here to re-run checks.</p>}
      <div className="row between">
        <span className="muted small">Updated {new Date(p.updatedAt).toLocaleDateString()}</span>
        <div className="row gap-sm">
          <button type="button" className="btn ghost sm" onClick={() => setRenaming(true)}>Rename</button>
          <button type="button" className="btn danger-ghost sm" onClick={async () => {
            if (!(await ask(`Delete “${p.name}”?`, 'Removes the dataset, its frames and its versions from this device (and the cloud, if you are signed in). You can undo for a few seconds.', 'Delete dataset'))) return
            const undo = await deleteProject(p.id)
            toast(`Deleted ${p.name}`, { undo: () => void undo() })
          }}>Delete</button>
        </div>
      </div>
    </article>
  )
}

