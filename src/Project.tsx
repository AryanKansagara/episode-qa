import { lazy, Suspense, useEffect, useState } from 'react'
import { makeVersion } from './engine/curate.ts'
import type { Episode } from './engine/types.ts'
import { fmtS, useDerived, useProject, type Derived } from './projectData.ts'
import { saveProject, uuid, type Project } from './store.ts'
import { Empty, go, isTyping, Link, Modal, SyntheticBadge, toast } from './ui.tsx'

const Tabs = lazy(() => import('./Tabs.tsx'))
const DataTab = lazy(() => import('./Import.tsx'))

export const TABS = [['overview', 'Overview'], ['episodes', 'Episodes'], ['operators', 'Operators'], ['balance', 'Balance & duplicates'], ['curate', 'Curate & export'], ['history', 'History'], ['data', 'Data & limits']] as const
export type Tab = (typeof TABS)[number][0]

export interface TabProps {
  project: Project
  ds: Episode[]
  d: Derived
  update(p: Partial<Project>, log?: string): Promise<unknown>
  saveVersion(label?: string): void
}

export default function ProjectView({ id, tab: rawTab }: { id: string; tab: string }) {
  const { loading, project, ds } = useProject(id)
  const tab = (TABS.some(t => t[0] === rawTab) ? rawTab : 'overview') as Tab
  const [help, setHelp] = useState(false)

  useEffect(() => { if (project) document.title = `${project.name} · Episode QA` }, [project?.name])

  const setTab = (t: Tab) => go(`/app/p/${id}${t === 'overview' ? '' : '/' + t}`, { keepScroll: true })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= TABS.length) { e.preventDefault(); setTab(TABS[n - 1][0]) }
      else if (e.key === '?') setHelp(true)
      else if (e.key === 'p' && project?.stats.length) go(`/app/p/${id}/report`)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  if (loading) return <div className="boot" role="status"><span className="spinner" /> Loading episodes</div>
  if (!project) return (
    <section className="page narrow center">
      <Empty title="Dataset not found"><p className="muted">It may have been deleted, or it lives on another device.</p><Link href="/app" className="btn primary">All datasets</Link></Empty>
    </section>
  )
  return <Loaded project={project} ds={ds ?? []} tab={tab} help={help} setHelp={setHelp} />
}

function Loaded({ project, ds, tab, help, setHelp }: { project: Project; ds: Episode[]; tab: Tab; help: boolean; setHelp(v: boolean): void }) {
  const d = useDerived(project)
  const empty = !project.stats.length
  const id = project.id

  const update = (patch: Partial<Project>, log?: string) => saveProject({ ...project, ...patch, ...(log ? { log: [...project.log, { at: Date.now(), text: log }] } : {}) })
  const saveVersion = (label?: string) => {
    if (empty) return
    const v = makeVersion(uuid(), label ?? `Version ${project.versions.length + 1}`, 'manual', d.stats, d.decisions, project.rules)
    void update({ versions: [...project.versions, v] })
    toast(`Saved “${v.label}”: ${v.kept} of ${v.episodes} episodes kept`, { tone: 'ok', undo: () => void saveProject({ ...project }) })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (!isTyping(e) && !e.metaKey && !e.ctrlKey && e.key === 'v') saveVersion() }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  const hours = project.stats.reduce((a, s) => a + s.duration, 0)
  return (
    <section className="page">
      <div className="proj-head">
        <div>
          <div className="eyebrow"><Link href="/app">Datasets</Link></div>
          <h1 className="row gap wrap">{project.name} {project.sampleId && <SyntheticBadge />}</h1>
          {!empty && <p className="muted small mono" style={{ margin: 0 }}>{project.stats.length} episodes · {fmtS(hours)} recorded · {d.keep.size} kept · {d.ops.length} operators</p>}
        </div>
        {!empty && (
          <div className="toolbar">
            <button type="button" className="btn outline" onClick={() => saveVersion()} title="Save a version (V)">Save version</button>
            <Link href={`/app/p/${id}/report`} className="btn primary" title="Printable report (P)">Report</Link>
          </div>
        )}
      </div>
      <nav className="tabs" aria-label="Dataset sections">
        {TABS.map(([t, l], i) => <Link key={t} href={`/app/p/${id}${t === 'overview' ? '' : '/' + t}`} aria-current={t === tab ? 'page' : undefined} title={`${l} (${i + 1})`}>{l}</Link>)}
      </nav>
      {project.dataMissing && tab !== 'data' && <div className="banner warn"><span><strong>Raw frames are on another device.</strong> Results, curation and exports work from the synced per-episode results; plots and re-running checks need a re-import here.</span></div>}
      <Suspense fallback={<div className="boot"><span className="spinner" /></div>}>
        {tab === 'data' || empty
          ? <DataTab project={project} ds={ds} d={d} update={update} saveVersion={saveVersion} />
          : <Tabs tab={tab} project={project} ds={ds} d={d} update={update} saveVersion={saveVersion} />}
      </Suspense>
      <Modal open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts">
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>7</kbd></dt><dd>Switch sections</dd></div>
          <div><dt><kbd>J</kbd> <kbd>K</kbd></dt><dd>Next / previous episode</dd></div>
          <div><dt><kbd>X</kbd> <kbd>A</kbd> <kbd>U</kbd></dt><dd>Exclude / always keep / reset the open episode</dd></div>
          <div><dt><kbd>V</kbd></dt><dd>Save a version</dd></div>
          <div><dt><kbd>P</kbd></dt><dd>Open the printable report</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last destructive action</dd></div>
        </dl>
      </Modal>
    </section>
  )
}
