// node scripts/qa-sync.mjs : signs up a throwaway account, round-trips a dataset and a version through the same tables the app syncs to, then deletes the account
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => l.split('=')))
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } })
const email = `qa-episode-qa-${Date.now()}@example.com`, password = 'qa-' + Math.random().toString(36).slice(2) + 'X9!'
const ok = (label, r) => { if (r.error) { console.log('FAIL', label, r.error.message); process.exitCode = 1 } else console.log('ok  ', label) }
const up = await sb.auth.signUp({ email, password }); ok('sign up ' + email, up)
if (!up.data.session) ok('sign in', await sb.auth.signInWithPassword({ email, password }))
const id = crypto.randomUUID(), vid = crypto.randomUUID()
ok('upsert dataset', await sb.from('projects').upsert({ id, app: 'episode-qa', name: 'QA dataset', data: { project: { id, name: 'QA dataset', rules: [{ id: 'r1', field: 'score', op: '<', value: '70', action: 'exclude', enabled: true }], overrides: { ep_002: 'keep' } } }, updated_at: new Date().toISOString() }))
ok('insert version', await sb.from('project_versions').insert({ id: vid, project_id: id, label: 'Week 44 import', data: { id: vid, label: 'Week 44 import', at: Date.now(), kept: 101, episodes: 120 } }))
const rows = await sb.from('projects').select('id,name,data').eq('app', 'episode-qa'); ok('read back', rows)
console.log(rows.data?.length === 1 && rows.data[0].data.project.overrides.ep_002 === 'keep' ? 'ok   round trip matches' : 'FAIL round trip')
const vs = await sb.from('project_versions').select('id').in('project_id', [id]); console.log(vs.data?.length === 1 ? 'ok   version round trip' : 'FAIL version')
ok('delete account', await sb.rpc('delete_my_account'))
const after = await sb.auth.signInWithPassword({ email, password }); console.log(after.error ? 'ok   account gone (' + after.error.message + ')' : 'FAIL account still exists')
