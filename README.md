# Episode QA

Quality control and curation for robot teleoperation datasets.

Teleop demonstrations are expensive, and the broken ones still end up in training: a camera clock that drifts 90 ms over an episode, a dropped burst of wrist frames, an operator who snaps the controller or idles for three seconds before moving, a grasp that slipped but was labelled a success, the same bag exported twice. Episode QA finds those, scores every episode, and exports a clean, trimmed episode list.

## Features

- **Import**: per-frame CSV / JSONL (LeRobot exports, including pandas array cells), LeRobot `episodes.jsonl`, camera frame timestamps, ROS bag CSV (topic, stamp, fields). Format detection, column mapping with glob patterns, validation report with line numbers.
- **Checks** (plain TypeScript, 31 tests): per-stream sample rate and dropped frames, camera vs joint-state offset and drift, jerk on commanded targets, position and velocity limit saturation against your joint limits, idle segments and trim ranges, grasp outcome (held / missed / slipped) and label contradictions, near-duplicates by DTW on downsampled end-effector paths, per-operator quality and feedback, task / tag balance.
- **Live episode viewer**: top-down trajectory and joint / gripper plot with a scrubber; issues appear as the playhead reaches them and the score updates.
- **Curate**: exclude / always-keep / trim rules, manual overrides, tags. Export curated CSV or JSON with trim ranges in seconds and frames, plus a LeRobot loading snippet.
- **Reports**: printable data quality report and operator feedback sheet.
- **History**: a version per import or on demand, compare any two (rules, inclusion changes, issue counts), and a change log.
- **Workspace**: multiple datasets in IndexedDB, optional email/password sync via Supabase (derived results sync; raw frames over 1.5 MB stay on the device), export / delete everything, undo, keyboard shortcuts, light and dark themes.
- **Sample**: a synthetic, labelled pick-and-place week (120 episodes, 3 operators, 7-DoF arm with gripper, 2 cameras) with planted drops, drift, jerk, saturation, idle, failed grasps and duplicates.

## Run locally

```sh
npm install
cp .env.example .env   # public Supabase URL and publishable key; optional
npm run dev
npm test
npm run build
```

Live: https://episode-qa.vercel.app

Built by Aryan Kansagara. Independent project, not affiliated with Sanctuary AI.
