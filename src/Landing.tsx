import { useMemo } from 'react'
import { defaultConfig } from './engine/analyze.ts'
import { generateEpisode, HERO_EPISODE } from './engine/sample.ts'
import { Link } from './ui.tsx'
import { Viewer } from './Viewer.tsx'

const CHECKS = [
  ['Dropped frames', 'Per-stream sample rate from the median period, then every gap longer than 1.5 periods, counted in missing frames for joint states and each camera.'],
  ['Camera sync drift', 'Start and end offset of each camera against the joint-state clock, and how fast it drifts in ms per second. A camera 90 ms off teaches the policy the wrong image for the action.'],
  ['Jerky actions', 'Third-difference jerk on the commanded joint targets, grouped into spikes. Snapped controllers and dropped teleop packets show up here.'],
  ['Limit saturation', 'Position within a margin of the joint limits you enter, and speed at the velocity limit. The policy cannot learn what the controller clamped.'],
  ['Idle and trim', 'Stationary stretches on a smoothed joint speed. Leading and trailing idle becomes a trim range; pauses mid-episode are flagged.'],
  ['Grasp outcome', 'Each close command judged by where the fingers settle and whether they stay: held, missed (closed on nothing) or slipped. Success labels that contradict it get flagged.'],
  ['Near-duplicates', 'Dynamic time warping on downsampled end-effector paths within each task. Re-exported or replayed episodes would otherwise double their weight.'],
  ['Operators and balance', 'A quality score per operator with plain-language feedback, and the task and tag mix of what you keep, so curation does not quietly erase a task.'],
]

const QUOTES = [
  ['Dexterous, contact-rich manipulation is the hardest data to collect. Every edge case turns into a manual intervention.', 'r/robotics, “What kind of real-world robotics data is hardest to collect today?”'],
  ['Teleop is the reliable way to get demonstrations, but it is slow, and bad episodes quietly poison the training set.', 'r/robotics, “Which is the best way to collect robot data?”'],
  ['Training data, not hardware, is going to be the bottleneck for general-purpose robots.', 'r/robotics, “Robotics training data is going to be a massive bottleneck”'],
]

export function Landing() {
  const ep = useMemo(() => generateEpisode(HERO_EPISODE), [])
  const cfg = useMemo(() => defaultConfig(), [])
  return (
    <>
      <section className="hero">
        <div className="hero-inner">
          <div>
            <div className="eyebrow">Teleop data QA</div>
            <h1>Every bad demonstration is a lesson your robot <em>learns anyway</em>.</h1>
            <p className="lede">Episode QA checks teleoperation logs before they reach training: dropped frames, camera drift, jerky or saturated commands, idle time, failed grasps and duplicates. Then it exports a clean, trimmed episode list your data loader can use.</p>
            <div className="hero-ctas">
              <Link href="/app?sample=1" className="btn primary lg">Try the sample dataset</Link>
              <Link href="/app" className="btn outline lg">Import your episodes</Link>
            </div>
            <p className="hero-note">Runs in your browser. LeRobot exports, ROS bag CSV and plain CSV / JSONL. No account needed.</p>
          </div>
          <div className="hero-card">
            <div className="hero-card-bar"><span className="badge">Live</span><span className="mono tiny">synthetic episode ep_019 · drag the plot to scrub</span></div>
            <Viewer ep={ep} cfg={cfg} autoplay title="Pick-and-place, op-ben" />
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div className="eyebrow">Why</div>
          <h2>Teleop hours are expensive. Training on the broken ones is worse.</h2>
          <p>Data-ops leads running collection talk about the same things: hard-won demonstrations, manual cleanup, and no time to watch every episode.</p>
        </div>
        <div className="quotes">
          {QUOTES.map(([q, s]) => <figure key={s} className="quote"><blockquote>{q}</blockquote><figcaption className="src">Paraphrased from {s}</figcaption></figure>)}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div className="eyebrow">What it checks</div>
          <h2>Eight checks, all explainable, all tunable.</h2>
          <p>Each check is a few lines of signal processing on timestamps and joint states, with the thresholds on the Settings page. Every flag points to a time in the episode.</p>
        </div>
        <div className="features">
          {CHECKS.map(([h, p], i) => <article key={h} className="feature"><div className="ico mono">{String(i + 1).padStart(2, '0')}</div><h3>{h}</h3><p>{p}</p></article>)}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div className="eyebrow">Workflow</div>
          <h2>From a week of collection to a training manifest.</h2>
        </div>
        <div className="score-steps">
          <div className="score-step"><b>01 Import</b><p>Per-frame CSV or JSONL, LeRobot episode metadata, camera timestamps or a ROS bag CSV. Columns are mapped for you, bad rows reported by line.</p></div>
          <div className="score-step"><b>02 Review</b><p>Score every episode, scrub the worst ones, see which operator and which rig the problems come from.</p></div>
          <div className="score-step"><b>03 Curate</b><p>Keep, exclude and trim rules, plus manual overrides and tags. Watch the task balance as you go.</p></div>
          <div className="score-step"><b>04 Ship</b><p>Download the curated list with trim ranges, a printable quality report and an operator feedback sheet. Versions record every change.</p></div>
        </div>
      </section>

      <section className="cta-band">
        <div className="cta-inner">
          <div><h2>Open a synthetic week of pick-and-place.</h2><p>120 episodes, 3 operators, a 7-DoF arm, 2 cameras, planted problems.</p></div>
          <Link href="/app?sample=1" className="btn primary lg">Open the sample</Link>
        </div>
      </section>
    </>
  )
}
