/**
 * Pure, deterministic state machines. The ONLY place project/scene status
 * transitions are defined. Services call these; nothing else writes status.
 */
import type { ProjectStatus, SceneStatus } from './schemas';

// ── Project ──────────────────────────────────────────────────────────────────

/** Stable stages, in pipeline order. */
export const STABLE_STAGES = [
  'draft', 'scripted', 'narrated', 'segmented', 'planned', 'assets_ready', 'assembled', 'qa_failed', 'qa_passed', 'rendered',
] as const satisfies readonly ProjectStatus[];

export const BUSY_STATUSES = ['scripting', 'narrating', 'segmenting', 'planning', 'qa_running', 'rendering'] as const satisfies readonly ProjectStatus[];

export type ProjectStep = 'script' | 'narration' | 'segment' | 'plan' | 'assets' | 'assemble' | 'qa' | 'render';

export type ProjectEvent =
  | { type: 'START'; step: ProjectStep }
  | { type: 'DONE'; step: ProjectStep; passed?: boolean }
  | { type: 'FAILED'; step: ProjectStep; revertTo: ProjectStatus }
  | { type: 'TIMELINE_STALE'; allAssetsReady: boolean }
  | { type: 'ASSETS_SETTLED'; allAssetsReady: boolean };

const RANK: Record<ProjectStatus, number> = {
  draft: 0, scripting: 0,
  scripted: 1, narrating: 1,
  narrated: 2, segmenting: 2,
  segmented: 3, planning: 3,
  planned: 4, producing: 4,
  assets_ready: 5,
  assembled: 6, qa_running: 6,
  qa_failed: 7, qa_passed: 7.5, rendering: 7.5,
  rendered: 8,
};

/** For each step: minimum stage rank required, the busy status while running, and the status on success. */
const STEPS: Record<ProjectStep, { requires: number; busy: ProjectStatus | null; done: ProjectStatus }> = {
  script: { requires: 0, busy: 'scripting', done: 'scripted' },
  narration: { requires: 1, busy: 'narrating', done: 'narrated' },
  segment: { requires: 2, busy: 'segmenting', done: 'segmented' },
  plan: { requires: 3, busy: 'planning', done: 'planned' },
  assets: { requires: 4, busy: 'producing', done: 'assets_ready' },
  assemble: { requires: 5, busy: null, done: 'assembled' }, // synchronous, deterministic
  qa: { requires: 6, busy: 'qa_running', done: 'qa_passed' },
  render: { requires: 7.5, busy: 'rendering', done: 'rendered' },
};

export class InvalidTransitionError extends Error {
  constructor(public from: string, public event: string, reason: string) {
    super(`Cannot ${event} while ${from}: ${reason}`);
    this.name = 'InvalidTransitionError';
  }
}

export function isBusy(status: ProjectStatus): boolean {
  return (BUSY_STATUSES as readonly string[]).includes(status);
}

export function stageRank(status: ProjectStatus): number {
  return RANK[status];
}

const STEP_LABEL: Record<ProjectStep, string> = {
  script: 'generate the script', narration: 'generate narration', segment: 'split scenes', plan: 'plan visuals',
  assets: 'generate assets', assemble: 'assemble the timeline', qa: 'run QA', render: 'render',
};

/** Returns null when allowed, otherwise a human-readable reason. */
export function whyCannotStart(status: ProjectStatus, step: ProjectStep): string | null {
  const def = STEPS[step];
  if (isBusy(status)) return `another pipeline step is running (${status.replace('_', ' ')})`;
  // Scene generation may run alongside itself; assembling/QA/render need all assets settled.
  // While scenes generate only more scene generation is allowed.
  if (status === 'producing' && step !== 'assets') return 'scene assets are still generating';
  if (RANK[status] < def.requires) {
    const needed = STABLE_STAGES.find((s) => RANK[s] >= def.requires) ?? 'a later stage';
    return `project must reach "${needed.replace('_', ' ')}" first`;
  }
  if (step === 'render' && status === 'qa_failed') return 'QA has failing checks; fix them and re-run QA';
  return null;
}

export function nextProjectStatus(current: ProjectStatus, event: ProjectEvent): ProjectStatus {
  switch (event.type) {
    case 'START': {
      const reason = whyCannotStart(current, event.step);
      if (reason) throw new InvalidTransitionError(current, STEP_LABEL[event.step], reason);
      const def = STEPS[event.step];
      return def.busy ?? def.done;
    }
    case 'DONE': {
      const def = STEPS[event.step];
      const expected = def.busy;
      if (expected && current !== expected) {
        // Scene assets can finish while project is already assets_ready etc. — handled by ASSETS_SETTLED.
        throw new InvalidTransitionError(current, `finish ${event.step}`, `expected status ${expected}`);
      }
      if (event.step === 'qa') return event.passed ? 'qa_passed' : 'qa_failed';
      return def.done;
    }
    case 'FAILED': {
      const def = STEPS[event.step];
      if (def.busy && current !== def.busy) return current; // already moved on (e.g. rewind) — do not clobber
      if (isBusy(event.revertTo) || event.revertTo === 'producing') return 'draft';
      return event.revertTo;
    }
    case 'TIMELINE_STALE': {
      // Any change to scenes/audio/captions invalidates assembled timeline, QA and render.
      if (RANK[current] <= RANK.assets_ready || isBusy(current) || current === 'producing') return current;
      return event.allAssetsReady ? 'assets_ready' : 'planned';
    }
    case 'ASSETS_SETTLED': {
      // Recomputed after every scene generation finishes / asset changes.
      if (current === 'producing' || current === 'planned' || current === 'assets_ready') {
        return event.allAssetsReady ? 'assets_ready' : 'planned';
      }
      if (RANK[current] > RANK.assets_ready && !isBusy(current)) {
        return event.allAssetsReady ? 'assets_ready' : 'planned';
      }
      return current;
    }
  }
}

/** Steps in UI order with labels, for the stage rail. */
export const PIPELINE: { step: ProjectStep; label: string; done: ProjectStatus }[] = [
  { step: 'script', label: 'Script', done: 'scripted' },
  { step: 'narration', label: 'Narration', done: 'narrated' },
  { step: 'segment', label: 'Scenes', done: 'segmented' },
  { step: 'plan', label: 'Visual plan', done: 'planned' },
  { step: 'assets', label: 'Assets', done: 'assets_ready' },
  { step: 'assemble', label: 'Timeline', done: 'assembled' },
  { step: 'qa', label: 'QA', done: 'qa_passed' },
  { step: 'render', label: 'Render', done: 'rendered' },
];

export function isStepComplete(status: ProjectStatus, step: ProjectStep): boolean {
  return RANK[status] >= RANK[STEPS[step].done] && status !== STEPS[step].busy;
}

// ── Scene ────────────────────────────────────────────────────────────────────

export type SceneEvent =
  | { type: 'PLAN' }
  | { type: 'ENQUEUE' }
  | { type: 'START' }
  | { type: 'SUCCEED' }
  | { type: 'FAIL' }
  | { type: 'REPLACE' }
  | { type: 'EDIT' };

export interface SceneSnapshot { status: SceneStatus; locked: boolean; hasAsset: boolean }

export function nextSceneStatus(scene: SceneSnapshot, event: SceneEvent): SceneStatus {
  const { status, locked } = scene;
  const deny = (why: string): never => { throw new InvalidTransitionError(`scene ${status}`, event.type.toLowerCase(), why); };
  const mutating = ['PLAN', 'ENQUEUE', 'REPLACE', 'EDIT'];
  if (locked && mutating.includes(event.type)) deny('scene is locked');
  switch (event.type) {
    case 'PLAN':
      if (status === 'queued' || status === 'generating') deny('generation in progress');
      return scene.hasAsset ? 'generated' : 'planned';
    case 'ENQUEUE':
      if (status === 'pending') deny('scene has no visual brief yet — plan visuals first');
      if (status === 'queued' || status === 'generating') return status; // alternatives add to the running batch
      return 'queued';
    case 'START':
      if (status !== 'queued' && status !== 'generating') deny('scene is not queued');
      return 'generating';
    case 'SUCCEED':
      return 'generated';
    case 'FAIL':
      return scene.hasAsset ? 'generated' : 'failed';
    case 'REPLACE':
      if (status === 'pending') deny('scene has no visual brief yet');
      return 'generated';
    case 'EDIT':
      if (status === 'queued' || status === 'generating') deny('generation in progress');
      return status === 'pending' ? 'pending' : scene.hasAsset ? 'generated' : 'planned';
  }
}
