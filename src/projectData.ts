import { useEffect, useMemo, useState } from 'react'
import { analyzeEpisode, dupClusters, nearDuplicates, operatorStats } from './engine/analyze.ts'
import { curate, DEFAULT_RULES, makeVersion, type Rule } from './engine/curate.ts'
import { generateSample, SAMPLE_COUNT, SAMPLE_ID, SAMPLE_NAME } from './engine/sample.ts'
import type { Config, Episode, EpisodeStats } from './engine/types.ts'
import { getData, getDefaults, getProjects, saveProject, useProjects, uuid, type Dataset, type Project } from './store.ts'

export const newRules = (): Rule[] => DEFAULT_RULES.map(r => ({ ...r, id: uuid() }))
export const analyzeAll = (ds: Episode[], cfg: Config): EpisodeStats[] => ds.map(e => analyzeEpisode(e, cfg))

export async function createSampleProject(): Promise<Project> {
  const existing = getProjects().find(p => p.sampleId === SAMPLE_ID)
  if (existing) return existing
  const config = getDefaults()
  const ds = generateSample()
  const stats = analyzeAll(ds, config)
  const now = Date.now()
  // Two versions so History has something to compare: the first pass, then tighter rules a day later.
  const loose = newRules().map(r => r.field === 'score' ? { ...r, value: '50' } : r).filter(r => r.field !== 'labelMismatch')
  const rules = newRules()
  const ctx = derive(stats, {}, { th: config.th }).ctx
  const v1 = makeVersion(uuid(), 'Week 44 import', 'import', stats, curate(stats, loose, {}, ctx), loose, now - 86400000)
  const v2 = makeVersion(uuid(), 'Stricter score floor, label check', 'rules', stats, curate(stats, rules, {}, ctx), rules, now - 3600000)
  return saveProject({
    id: uuid(), name: SAMPLE_NAME, createdAt: now, updatedAt: now, config, rules, overrides: {}, tagEdits: {}, stats, versions: [v1, v2], sampleId: SAMPLE_ID,
    log: [
      { at: now - 86400000, text: `Imported ${SAMPLE_COUNT} synthetic episodes (3 operators, 2 cameras)` },
      { at: now - 3600000, text: 'Score floor raised from 50 to 70' },
      { at: now - 3600000, text: 'Added rule: exclude episodes where the success label contradicts the grasp' },
    ],
    imports: [{ id: uuid(), kind: 'frames', fileName: 'synthetic pick-and-place, week 44', rows: ds.reduce((a, e) => a + e.t.length, 0), skipped: 0, episodes: ds.length, at: now - 86400000 }],
  })
}

export async function createBlankProject(name: string): Promise<Project> {
  const now = Date.now()
  return saveProject({ id: uuid(), name, createdAt: now, updatedAt: now, config: getDefaults(), rules: newRules(), overrides: {}, tagEdits: {}, stats: [], versions: [], log: [], imports: [] })
}

/** Loads a project and, when this device has them, its raw episodes. */
export function useProject(id: string) {
  const list = useProjects()
  const project = list?.find(p => p.id === id) ?? null
  const [ds, setDs] = useState<Dataset | null>(null)
  const importsKey = project ? project.imports.map(i => i.id).join(',') : ''
  useEffect(() => {
    if (!project) return
    let live = true
    if (project.sampleId) { setDs(generateSample()); return }
    void getData(project.id).then(d => { if (live) setDs(d ?? []) })
    return () => { live = false }
  }, [project?.id, project?.sampleId, importsKey])
  return { loading: list === null || (project !== null && ds === null), project, ds }
}

/** Dataset-level results from stats alone. */
export function derive(rawStats: EpisodeStats[], tagEdits: Record<string, string[]>, cfg: Pick<Config, 'th'>) {
  const stats = rawStats.map(s => tagEdits[s.id] ? { ...s, tags: tagEdits[s.id] } : s)
  const pairs = nearDuplicates(stats, cfg.th.dupDist)
  const clusters = dupClusters(pairs, stats)
  const ctx = { dupDrop: new Set(clusters.flatMap(c => c.drop)) }
  return { stats, pairs, clusters, ctx, ops: operatorStats(stats) }
}

export function useDerived(p: Project) {
  const base = useMemo(() => derive(p.stats, p.tagEdits, p.config), [p.stats, p.tagEdits, p.config.th.dupDist])
  const decisions = useMemo(() => curate(base.stats, p.rules, p.overrides, base.ctx), [base, p.rules, p.overrides])
  const keep = useMemo(() => new Set(decisions.filter(d => d.include).map(d => d.id)), [decisions])
  return { ...base, decisions, keep }
}
export type Derived = ReturnType<typeof useDerived>

export const fmtS = (s: number) => s < 60 ? `${s.toFixed(1)} s` : s < 3600 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(2)} h`
export const scoreTone = (s: number) => s >= 85 ? 'good' : s >= 70 ? 'ok' : s >= 50 ? 'warn' : 'bad'
