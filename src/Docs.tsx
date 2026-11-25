import { Code, Link } from './ui.tsx'

const LEROBOT = `# LeRobot stores frames as parquet: data/chunk-000/episode_000000.parquet (v2.x)
# or data/chunk-000/file-000.parquet (v3.0). One CSV for the whole dataset:
python -c "import pandas as pd, glob; pd.concat(pd.read_parquet(f) for f in sorted(glob.glob('data/chunk-*/*.parquet'))).to_csv('frames.csv', index=False)"

# No Python? Any public Hub dataset as JSONL through the Hugging Face dataset viewer API
# (100 rows per request; raise offset until you have the episodes you want):
for o in 0 100 200 300 400; do
  curl -s "https://datasets-server.huggingface.co/rows?dataset=lerobot/koch_pick_place_1_lego&config=default&split=train&offset=$o&length=100" | jq -c '.rows[].row'
done > frames.jsonl

# Task names: v2.x has meta/episodes.jsonl, drop it as is. v3.0 keeps them in parquet:
python -c "import pandas as pd, glob; pd.concat(pd.read_parquet(f) for f in glob.glob('meta/episodes/*/*.parquet'))[['episode_index','tasks','length']].to_json('episodes.jsonl', orient='records', lines=True)"`

const FRAMES = `episode_index,frame_index,timestamp,observation.state.0,...,observation.state.6,action.0,...,action.6,observation.gripper,action.gripper,observation.ee_pos.0,observation.ee_pos.1,observation.ee_pos.2,operator,task,success
ep_000,0,0.0000,-0.0841,...,0.5123,-0.0839,...,0.5125,1.0000,0,0.45000,0.00000,0.42000,op-ana,cube to bin,true
ep_000,1,0.0333,-0.0841,...,0.5123,-0.0838,...,0.5126,0.9990,0,0.45000,0.00000,0.42000,op-ana,cube to bin,true`

const CAMS = `episode_index,camera,timestamp
ep_000,wrist,0.0012
ep_000,wrist,0.0346
ep_000,head,0.0119`

const EPISODES = `{"episode_index": "ep_000", "tasks": ["cube to bin"], "operator": "op-ana", "success": true, "tags": ["rig-1", "clutter"]}
{"episode_index": "ep_001", "tasks": ["cube to bin"], "operator": "op-ben", "success": false, "tags": ["rig-1"]}`

const ROS = `# Works for ROS 1 .bag and ROS 2 (sqlite3 / mcap) bags
pip install rosbags
python - <<'PY'
from rosbags.highlevel import AnyReader; from pathlib import Path; import csv
with AnyReader([Path('episode_042')]) as r, open('episode_042.csv','w',newline='') as f:
    w = csv.writer(f); w.writerow(['topic','stamp'] + [f'field.position{i}' for i in range(7)] + ['field.data'])
    for c, t, raw in r.messages():
        m = r.deserialize(raw, c.msgtype)
        if hasattr(m, 'position'): w.writerow([c.topic, t] + list(m.position)[:7] + [''])
        elif hasattr(m, 'data'): w.writerow([c.topic, t] + ['']*7 + [m.data])
        else: w.writerow([c.topic, t] + ['']*8)   # images: stamp only
PY`

export default function Docs() {
  return (
    <section className="page narrow docs">
      <div className="eyebrow">Docs</div>
      <h1>Getting episodes into Episode QA</h1>
      <p className="lede">Everything is parsed in your browser. Drop one or more files on a dataset&rsquo;s Data tab; the format is detected, columns are mapped, and every bad row is reported with its line number. Last reviewed November 2026.</p>
      <nav className="toc" aria-label="On this page">
        <a href="#formats">Formats</a><a href="#convert">LeRobot / parquet</a><a href="#ros">ROS bags</a><a href="#cameras">Camera timestamps</a><a href="#checks">How each check works</a><a href="#scoring">Scoring</a><a href="#export">Exports</a><a href="#privacy">Privacy and sync</a>
      </nav>

      <h2 id="formats">Accepted formats</h2>
      <ul>
        <li><strong>Per-frame table</strong> (CSV, TSV or JSONL): one row per joint-state sample. Needs an episode id, a timestamp and joint position columns. Without an id column the file name is used, as long as the file holds a single recording. Optional: commanded joint targets, gripper opening (0 closed to 1 open; mm is rescaled), gripper command (1 = close), end-effector x/y/z in metres, task, operator, success.</li>
        <li><strong>Episode metadata</strong> (JSONL or CSV): LeRobot <code>meta/episodes.jsonl</code> works as is. Adds task, operator, success label and tags to episodes already imported.</li>
        <li><strong>Camera frame timestamps</strong> (CSV or JSONL): <code>episode, camera, timestamp</code>, one row per frame. Needed for camera drop and sync checks when your per-frame table does not carry them.</li>
        <li><strong>ROS bag CSV</strong>: rows with a topic column and a stamp, written by the short rosbags script below. One file per bag; the file name becomes the episode id unless you map an episode column.</li>
      </ul>
      <p>Timestamps can be seconds, milliseconds, microseconds or nanoseconds (one unit per column: epoch values by their size, values relative to a start by their typical gap, with a warning that names the unit and a menu to change it), <code>secs:nsecs</code>, or ISO 8601. Array cells written by pandas (<code>"[0.1, 0.2]"</code>) and nested JSON arrays are split into <code>name.0</code>, <code>name.1</code> columns, so <code>observation.state.*</code> matches LeRobot&rsquo;s state vector.</p>
      <Code label="Per-frame CSV (what the sample download looks like)" code={FRAMES} />
      <Code label="episodes.jsonl" code={EPISODES} />

      <h2 id="convert">LeRobot and other parquet datasets</h2>
      <p>Parquet is not read in the browser. Convert once with pandas (already a LeRobot dependency):</p>
      <Code label="shell" code={LEROBOT} />
      <p>Joint units are read as they are stored. Koch and SO-100 datasets record motor angles in degrees; values beyond &plusmn;2&pi; are detected as degrees and converted to radians (override with the angle units option on import). Frame tables that only carry <code>task_index</code> show &ldquo;task 0&rdquo; until you drop <code>episodes.jsonl</code>, which fills in the task text.</p>
      <p>The importer is tested against real public exports: the first episodes of <a href="https://huggingface.co/datasets/lerobot/koch_pick_place_1_lego">lerobot/koch_pick_place_1_lego</a> (Apache-2.0, 6 motors in degrees, 30 Hz) and <a href="https://huggingface.co/datasets/lerobot/aloha_sim_insertion_human">lerobot/aloha_sim_insertion_human</a> (MIT, 14 joints in radians, 50 Hz), both as JSONL from the dataset viewer API and as pandas <code>to_csv</code> output with array cells, plus their v2.1 <code>meta/episodes.jsonl</code> (fetched November 2026). On that data the default 250 rad/s&sup3; jerk limit flags a dozen spikes per Koch episode, because leader-arm encoder steps are jerky at 30 Hz; use &ldquo;fit to this data&rdquo; under Thresholds to set the limit from your own dataset.</p>
      <p>LeRobot videos are decoded at <code>frame_index / fps</code>, so they cannot drift relative to the state by construction. If your logger records real camera capture stamps, export them as a camera timestamp file (below); that is where drift shows up.</p>

      <h2 id="ros">ROS bags</h2>
      <Code label="shell" code={ROS} />
      <p>Topic roles are matched with regexes you can edit on import: joint states (<code>joint_states</code>), actions (<code>command|action|joint_cmd</code>), gripper (<code>gripper</code>) and cameras (<code>image|camera|rgb</code>). Gripper and action values are held until the next message, so they line up with each joint-state sample.</p>

      <h2 id="cameras">Camera timestamps</h2>
      <Code label="cameras.csv" code={CAMS} />
      <p>Use the same clock base as the joint-state file (absolute or episode-relative). Offsets are measured as camera first frame minus joint first sample, and camera last frame minus joint last sample. This assumes both recorders start and stop on the same trigger, which is how most teleop loggers work; if yours starts cameras early on purpose, raise the offset warning.</p>

      <h2 id="checks">How each check works</h2>
      <ul>
        <li><strong>Sample rate and dropped frames</strong>: period = median gap between timestamps. Any gap above 1.5 periods counts as round(gap / period) &minus; 1 missing frames. Drop rate = missing / (received + missing), per stream; the episode takes its worst stream.</li>
        <li><strong>Sync offset and drift</strong>: start and end offsets of each camera against the joint clock; drift = change in offset per second of episode. Flagged above the offset warning (default 25 ms, roughly one frame at 30 Hz plus jitter).</li>
        <li><strong>Jerk</strong>: third difference of commanded targets (measured positions if there are none) divided by period³, max over joints. Windows that span a dropped gap are skipped so drops do not look like jerk. Spikes within 0.2 s merge into one event. The default limit suits a smooth 30 Hz arm; &ldquo;fit to this data&rdquo; sets it to twice the median of each episode&rsquo;s 99th-percentile jerk, so only outliers for your robot count.</li>
        <li><strong>Saturation</strong>: skipped while the number of limits differs from the number of joint columns, because limits for another arm would flag every frame. A frame is saturated when any joint is within the margin (1% of its range) of a limit or at 98% of its speed limit. Enter your arm&rsquo;s limits on the Data tab; the defaults are a generic 7-DoF arm.</li>
        <li><strong>Idle</strong>: fastest joint speed on a 5-frame moving average below 0.03 rad/s for at least 1.5 s. Idle touching the start or end becomes a trim range (keeping 0.25 s of padding). An episode that is idle from start to end is flagged as never moving and gets no trim.</li>
        <li><strong>Grasps</strong>: each rising edge of the gripper command is a grasp. After the settle time (0.4 s) an opening below 0.06 means the fingers closed on nothing (missed); if it later falls below 0.06 while still commanded closed, the object slipped. An episode labelled success whose last judged grasp failed is flagged.</li>
        <li><strong>Near-duplicates</strong>: end-effector paths (or the first three joints) are downsampled to 32 points and compared by dynamic time warping within each task. Mean step distance at or below 6 mm is a duplicate; the best-scoring copy that no other rule or manual choice excludes is kept, and only episodes within the limit of it are dropped.</li>
        <li><strong>Operators and balance</strong>: per-operator means of the above, with feedback only where someone is 1.5&times; worse than the team median. Balance flags tasks under half or over double an even share of the kept set.</li>
      </ul>

      <p>A check that could not run (no camera timestamps, no judged grasp, limits for another joint count) reads &ldquo;&mdash;&rdquo; or &ldquo;not checked&rdquo;, never 0.</p>

      <h2 id="scoring">Quality score</h2>
      <p>100 minus penalties, each capped: drops (drop rate &times; 250, max 25), sync (offset beyond the warning / 4 per ms, max 15), jerk (4 per spike, max 20), saturation (% of frames, max 15), mid-episode idle (idle share &times; 40, max 10; an episode in which the arm never moves loses the full 40), failed grasps (10 each, max 20). Leading and trailing idle is not penalised because a trim fixes it. Weights are deliberately simple so you can explain an excluded episode to the operator who recorded it.</p>

      <h2 id="export">Exports</h2>
      <ul>
        <li><strong>Curated CSV</strong>: <code>episode_id, task, operator, success, include, trim_start_s, trim_end_s, trim_start_frame, trim_end_frame, score, tags, reasons</code>. Frame numbers are the values of the <code>frame_index</code> column when the file has one; otherwise they count the rows that were kept, from 0.</li>
        <li><strong>Curated JSON</strong>: kept episodes with trim ranges plus excluded episodes with reasons and the rules in force. The Curate tab has a Python snippet that loads it into <code>LeRobotDataset(episodes=...)</code>.</li>
        <li><strong>Printable report</strong> and <strong>operator feedback sheet</strong>: use the browser&rsquo;s print dialog to save a PDF.</li>
      </ul>

      <h2 id="privacy">Privacy and sync</h2>
      <p>Datasets live in your browser (IndexedDB). Signing in is optional; it syncs limits, thresholds, rules, tags, overrides, per-episode results and versions through Supabase with row-level security. Raw frames sync only when a dataset is under 1.5 MB; larger ones stay on the device where they were imported, and other devices can still curate and export from the synced results.</p>
      <p><Link href="/app" className="btn primary">Open your datasets</Link></p>
    </section>
  )
}
