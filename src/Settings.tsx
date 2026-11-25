import { useState } from 'react'
import { ConfigEditor } from './ConfigEditor.tsx'
import { deleteProject, getDefaults, getProjects, setDefaults } from './store.ts'
import { exportAll, RAW_SYNC_LIMIT, useSync } from './sync.ts'
import { ask, download, setTheme, toast, useDark } from './ui.tsx'
import type { Config } from './engine/types.ts'

export default function Settings() {
  const [cfg, setCfg] = useState<Config>(getDefaults)
  const dark = useDark()
  const sync = useSync()
  const save = (c: Config) => { setCfg(c); setDefaults(c) }

  return (
    <section className="page narrow settings">
      <div className="eyebrow">Settings</div>
      <h1>Settings</h1>

      <div className="panel">
        <h2>Defaults for new datasets</h2>
        <p className="muted small">Existing datasets keep their own limits and thresholds; change those on the dataset&rsquo;s Data &amp; limits tab. Saved automatically.</p>
        <ConfigEditor cfg={cfg} onChange={save} />
      </div>

      <div className="panel">
        <h2>Appearance</h2>
        <div className="seg-control" role="radiogroup" aria-label="Theme">
          <button type="button" role="radio" aria-checked={!dark} className={!dark ? 'on' : ''} onClick={() => setTheme('light')}>Light</button>
          <button type="button" role="radio" aria-checked={dark} className={dark ? 'on' : ''} onClick={() => setTheme('dark')}>Dark</button>
        </div>
      </div>

      <div className="panel">
        <h2>Your data</h2>
        <p>Datasets live in this browser (IndexedDB). {sync.user ? <>Signed in as <b>{sync.user.email}</b>: limits, rules, tags, per-episode results and versions sync to your account, plus raw frames when they are under {(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB per dataset.</> : 'Sign in from the account menu (top right) to sync across devices. It is optional.'}</p>
        <div className="row gap wrap">
          <button type="button" className="btn ghost" onClick={async () => download(`episode-qa-export-${new Date().toISOString().slice(0, 10)}.json`, await exportAll())}>Export all my data (JSON)</button>
          <button type="button" className="btn danger-ghost" onClick={async () => {
            const list = getProjects()
            if (!list.length) { toast('Nothing to delete'); return }
            if (!(await ask('Delete all local datasets?', `Removes ${list.length} dataset${list.length > 1 ? 's' : ''} from this browser${sync.user ? ' and from your cloud account' : ''}. You can undo for a few seconds.`, 'Delete everything'))) return
            const undos = await Promise.all(list.map(p => deleteProject(p.id)))
            toast(`Deleted ${list.length} datasets`, { undo: () => { for (const u of undos) void u() } })
          }}>Delete all datasets</button>
        </div>
      </div>

      <div className="panel">
        <h2>Keyboard shortcuts</h2>
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>7</kbd></dt><dd>Switch dataset sections</dd></div>
          <div><dt><kbd>J</kbd> <kbd>K</kbd></dt><dd>Next / previous episode in the episode view</dd></div>
          <div><dt><kbd>X</kbd> <kbd>A</kbd></dt><dd>Exclude / always keep the open episode</dd></div>
          <div><dt><kbd>V</kbd></dt><dd>Save a version</dd></div>
          <div><dt><kbd>P</kbd></dt><dd>Printable quality report</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last destructive action</dd></div>
          <div><dt><kbd>?</kbd></dt><dd>Show shortcuts on a dataset page</dd></div>
        </dl>
      </div>
    </section>
  )
}
