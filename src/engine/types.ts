/** One teleoperation episode, normalized. All times are seconds on the joint-state clock, starting at 0. */
export interface Episode {
  id: string
  task: string
  operator: string
  /** Success label from the operator or the dataset (null when unlabelled). */
  success: boolean | null
  tags: string[]
  t: number[]
  /** Measured joint positions [frame][joint], radians. */
  q: number[][]
  /** Commanded joint targets [frame][joint]; jerk is measured on these when present. */
  act?: number[][]
  /** Gripper opening, 0 = fully closed, 1 = fully open. */
  grip?: number[]
  /** Gripper command, 1 = close, 0 = open. */
  gripCmd?: number[]
  /** End-effector position [frame][x, y, z], metres. */
  ee?: number[][]
  /** Camera frame timestamps per camera (seconds, same zero as t, so start offsets survive). */
  cams: Record<string, number[]>
  /** Original first joint timestamp, used to line up camera files imported later. */
  t0?: number
}

export interface JointLimit { name: string; min: number; max: number; vel: number }

export interface Thresholds {
  /** A gap larger than this many median periods counts as dropped frames. */
  dropFactor: number
  /** Jerk above this (rad/s^3) on any joint is a spike. */
  jerkLimit: number
  /** Joint speed below this (rad/s) on every joint counts as stationary. */
  idleSpeed: number
  /** Stationary stretches shorter than this (s) are ignored. */
  idleMinSec: number
  /** Time after a close command before the grasp is judged (s). */
  settleSec: number
  /** Gripper opening below this means the fingers closed on nothing. */
  emptyGrip: number
  /** Fraction of the joint range near a limit that counts as saturated. */
  satMargin: number
  /** Camera vs joint clock offset above this (ms) is flagged. */
  offsetWarnMs: number
  /** Mean DTW step distance (m, or rad when no end-effector) below which two episodes are near-duplicates. */
  dupDist: number
}

export interface Config { limits: JointLimit[]; th: Thresholds }

export type IssueKind = 'drop' | 'sync' | 'jerk' | 'saturation' | 'idle' | 'grasp' | 'label'
export interface Issue { kind: IssueKind; t: number; t2?: number; msg: string }

export interface StreamStats { name: string; frames: number; hz: number; dropped: number; dropRate: number }
export interface CamStats extends StreamStats { offsetMs: number; endOffsetMs: number; driftMsPerS: number }
export type GraspOutcome = 'held' | 'missed' | 'slipped' | 'unknown'
export interface Grasp { t: number; tOpen: number; outcome: GraspOutcome; tFail?: number }

/** Everything derived from one episode. Small enough to sync without the raw frames. */
export interface EpisodeStats {
  id: string
  task: string
  operator: string
  success: boolean | null
  tags: string[]
  duration: number
  frames: number
  joints: StreamStats
  cams: CamStats[]
  /** Worst dropped-frame rate across all streams. */
  dropRate: number
  /** Worst absolute camera-vs-joint offset over the episode, ms. */
  syncMs: number
  jerkEvents: number
  jerkPeak: number
  satFrac: number
  satJoints: number[]
  idleSec: number
  /** Idle time that is neither leading nor trailing. */
  midIdleSec: number
  /** Leading plus trailing idle, the part a trim removes. */
  edgeIdleSec: number
  trim: [number, number]
  trimFrames: [number, number]
  grasps: Grasp[]
  failedGrasps: number
  issues: Issue[]
  penalties: Record<string, number>
  score: number
  /** Downsampled path for near-duplicate search. */
  path: number[][]
}
