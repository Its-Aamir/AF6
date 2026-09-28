/**
 * Autonomous Production Mode. A durable, self-rescheduling job drives the
 * project through the normal pipeline services (same state machine, budget
 * guard and validation as manual use), retries failed steps, regenerates failed
 * scenes, and stops with a clear message when it needs a human.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AutopilotState, AutopilotStep, ProjectStatus } from '../../shared/schemas';
import type { Db } from '../db/client';
import { jobs, projects, scenes, type ProjectRow } from '../db/schema';
import { AppError, notFound, toAppError } from '../errors';
import { done, reschedule, type JobHandler } from '../jobs/types';
import { listProviders } from '../providers/registry';
import { enqueue } from '../queue/queue';
import {
  assembleProjectTimeline, generateCaptions, requestMusic, requestPackage, startNarration, startPlan, startQa, startRender, startScript, startSegment,
} from './pipeline';
import { generateAllScenes } from './scenes';

const MAX_STEP_ATTEMPTS = 3;
const MAX_FIX_ROUNDS = 2;
const BUSY: ProjectStatus[] = ['scripting', 'narrating', 'segmenting', 'planning', 'qa_running', 'rendering', 'producing'];

type Expect = { step: AutopilotStep; from: ProjectStatus; at: string };
type State = AutopilotState & { expect?: Expect | null; packagedFor?: string | null };

async function save(db: Db, id: string, s: State) {
  await db.update(projects).set({ autopilot: s, updatedAt: new Date() }).where(eq(projects.id, id));
}

function logLine(s: State, message: string): State {
  const log = [...(s.log ?? []), { at: new Date().toISOString(), message }].slice(-60);
  return { ...s, message, log };
}

export async function startAutopilot(db: Db, projectId: string, preset: 'draft' | 'final' | 'hd' = 'final') {
  const p = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!p) throw notFound('Project');
  if (p.autopilot?.running) throw new AppError('CONFLICT', 'Autopilot is already running for this project.');
  const state: State = {
    running: true, step: 'script', message: 'Starting autopilot', startedAt: new Date().toISOString(), finishedAt: null, jobId: null,
    attempts: {}, fixRounds: 0, error: null, preset, log: [{ at: new Date().toISOString(), message: 'Autopilot started' }], expect: null,
  };
  return db.transaction(async (tx) => {
    const { job } = await enqueue(tx, { type: 'project.autopilot', payload: { projectId }, projectId, dedupeKey: `autopilot:${projectId}` });
    await tx.update(projects).set({ autopilot: { ...state, jobId: job.id }, lastError: null, updatedAt: new Date() }).where(eq(projects.id, projectId));
    return job;
  });
}

export async function stopAutopilot(db: Db, projectId: string, reason = 'Stopped by user') {
  const p = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!p?.autopilot?.running) return;
  await save(db, projectId, logLine({ ...(p.autopilot as State), running: false, finishedAt: new Date().toISOString(), error: reason }, reason));
}

/** Is there a real (non-mock) connected provider for a capability? */
function hasRealProvider(capability: 'music'): boolean {
  return listProviders().some((pr) => pr.transport !== 'mock' && pr.implemented && pr.configStatus().configured && pr.models.some((m) => m.capability === capability && m.unitCostUsd != null));
}

async function sceneState(db: Db, projectId: string) {
  const rows = await db.select({ index: scenes.index, status: scenes.status, asset: scenes.selectedAssetId, error: scenes.error, locked: scenes.locked }).from(scenes).where(eq(scenes.projectId, projectId)).orderBy(scenes.index);
  return { rows, missing: rows.filter((r) => !r.asset), failed: rows.filter((r) => r.status === 'failed') };
}

async function activeJob(db: Db, projectId: string, type: string) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(jobs).where(and(eq(jobs.projectId, projectId), eq(jobs.type, type), inArray(jobs.status, ['queued', 'running'])));
  return r.n > 0;
}

/** Decide and perform the next action. Returns a delay to wait, or null when finished/stopped. */
async function tick(db: Db, p: ProjectRow, s: State): Promise<{ state: State; delayMs: number | null }> {
  const status = p.status as ProjectStatus;

  // A step we started came back to where it began with an error → it failed.
  if (s.expect && status === s.expect.from && p.lastError && p.updatedAt.toISOString() >= s.expect.at) {
    const n = (s.attempts[s.expect.step] ?? 0);
    if (n >= MAX_STEP_ATTEMPTS) {
      return { state: logLine({ ...s, running: false, error: `Stopped at "${s.expect.step}": ${p.lastError}`, finishedAt: new Date().toISOString(), expect: null }, `Stopped: ${p.lastError}`), delayMs: null };
    }
    s = logLine({ ...s, expect: null }, `Step "${s.expect.step}" failed (${p.lastError}); retrying`);
  }
  if (BUSY.includes(status)) {
    if (status === 'producing') {
      const { rows, missing } = await sceneState(db, p.id);
      return { state: { ...s, step: 'assets', message: `Generating visuals: ${rows.length - missing.length}/${rows.length} scenes ready` }, delayMs: 2000 };
    }
    return { state: s, delayMs: 1500 };
  }

  const begin = async (step: AutopilotStep, message: string, fn: () => Promise<unknown>) => {
    const attempts = { ...s.attempts, [step]: (s.attempts[step] ?? 0) + 1 };
    const next = logLine({ ...s, step, attempts, expect: { step, from: status, at: new Date().toISOString() } }, message);
    await fn();
    return { state: next, delayMs: 800 };
  };

  switch (status) {
    case 'draft': return begin('script', p.inputMode === 'script' ? 'Analysing your script' : 'Writing the script', () => startScript(db, p.id, true));
    case 'scripted': return begin('narration', p.voiceoverAssetId ? 'Aligning your voiceover to the script' : 'Generating the voiceover', () => startNarration(db, p.id, true));
    case 'narrated': return begin('segment', 'Cutting scenes on the narration timing', () => startSegment(db, p.id, true));
    case 'segmented': return begin('plan', 'AI Director is planning visuals and prompts', () => startPlan(db, p.id));
    case 'planned': {
      const { missing, failed } = await sceneState(db, p.id);
      if (!missing.length) return { state: s, delayMs: 500 };
      if (s.attempts.assets && failed.length) {
        if (s.fixRounds >= MAX_FIX_ROUNDS) {
          const detail = failed.map((f) => `#${f.index}${f.error ? ` (${f.error.slice(0, 80)})` : ''}`).join(', ');
          return { state: logLine({ ...s, running: false, error: `Scenes still failing after ${MAX_FIX_ROUNDS} retries: ${detail}. Switch their model or upload a visual, then run Autopilot again.`, finishedAt: new Date().toISOString() }, 'Stopped: scenes failing'), delayMs: null };
        }
        s = { ...s, fixRounds: s.fixRounds + 1 };
        return begin('assets', `Re-generating ${failed.length} failed scene(s) (fix round ${s.fixRounds})`, () => generateAllScenes(db, p.id));
      }
      return begin('assets', `Generating visuals for ${missing.length} scene(s)`, () => generateAllScenes(db, p.id));
    }
    case 'assets_ready': {
      if (p.captions.enabled && !p.captions.cues.length) {
        await generateCaptions(db, p.id);
        return { state: logLine({ ...s, step: 'captions' }, 'Captions built from the narration timing'), delayMs: 300 };
      }
      if (p.music.enabled && !p.musicAssetId) {
        if (await activeJob(db, p.id, 'music.generate')) return { state: { ...s, step: 'music', message: 'Generating music' }, delayMs: 1500 };
        const demo = p.narrationTimingSource === 'simulated';
        if (hasRealProvider('music') || demo) return begin('music', 'Generating music', () => requestMusic(db, p.id));
        await db.update(projects).set({ music: { ...p.music, enabled: false }, updatedAt: new Date() }).where(eq(projects.id, p.id));
        return { state: logLine({ ...s, step: 'music' }, 'No music uploaded and no music provider connected — continuing with narration only'), delayMs: 300 };
      }
      if (await activeJob(db, p.id, 'music.generate')) return { state: { ...s, step: 'music', message: 'Waiting for music' }, delayMs: 1500 };
      await assembleProjectTimeline(db, p.id);
      return { state: logLine({ ...s, step: 'assemble' }, 'Timeline assembled'), delayMs: 300 };
    }
    case 'assembled': return begin('qa', 'Running QA', () => startQa(db, p.id));
    case 'qa_failed': {
      const fails = p.qaReport?.checks.filter((c) => c.status === 'fail') ?? [];
      const sceneFails = fails.filter((c) => c.sceneId);
      if (sceneFails.length && s.fixRounds < MAX_FIX_ROUNDS) {
        // Clear the broken visuals so they are regenerated.
        await db.update(scenes).set({ selectedAssetId: null, status: 'planned', updatedAt: new Date() })
          .where(and(eq(scenes.projectId, p.id), eq(scenes.locked, false), inArray(scenes.id, sceneFails.map((c) => c.sceneId!))));
        await db.update(projects).set({ status: 'planned', updatedAt: new Date() }).where(eq(projects.id, p.id));
        return { state: logLine({ ...s, fixRounds: s.fixRounds + 1 }, `QA found ${sceneFails.length} broken scene(s); regenerating`), delayMs: 300 };
      }
      if (fails.some((c) => c.id === 'timeline.current')) {
        await assembleProjectTimeline(db, p.id);
        return { state: logLine(s, 'Re-assembled the timeline'), delayMs: 300 };
      }
      return { state: logLine({ ...s, running: false, error: `QA failed: ${fails.map((f) => f.message).join(' ')}`, finishedAt: new Date().toISOString() }, 'Stopped: QA failed'), delayMs: null };
    }
    case 'qa_passed': return begin('render', `Rendering (${s.preset})`, () => startRender(db, p.id, s.preset));
    case 'rendered': {
      if (s.packagedFor !== p.finalRenderAssetId) {
        if (await activeJob(db, p.id, 'package.export')) return { state: { ...s, step: 'package', message: 'Packaging' }, delayMs: 1000 };
        if (s.step !== 'package') {
          await requestPackage(db, p.id);
          return { state: logLine({ ...s, step: 'package' }, 'Packaging video, captions and sources'), delayMs: 1000 };
        }
        s = { ...s, packagedFor: p.finalRenderAssetId };
      }
      const ready = p.renderReport?.publishReady;
      const why = p.renderReport?.checks.filter((c) => c.status === 'fail').map((c) => c.message).join(' ') || 'see the Publish tab';
      return {
        state: logLine({ ...s, step: 'done', running: false, finishedAt: new Date().toISOString(), expect: null }, ready ? 'Done — the video is ready to upload' : `Done — rendered, but not ready to upload: ${why}`),
        delayMs: null,
      };
    }
    default: return { state: s, delayMs: 1500 };
  }
}

export const autopilotHandler: JobHandler<{ projectId: string }> = {
  type: 'project.autopilot',
  payloadSchema: z.object({ projectId: z.string().uuid() }),
  async run({ db, payload }) {
    const p = await db.query.projects.findFirst({ where: eq(projects.id, payload.projectId) });
    if (!p) return done({ skipped: 'project deleted' });
    const s = p.autopilot as State | null;
    if (!s?.running) return done({ stopped: true });
    let result: { state: State; delayMs: number | null };
    try {
      result = await tick(db, p, s);
    } catch (e) {
      const err = toAppError(e);
      if (err.retryable) throw err; // transient: the queue retries this tick
      await save(db, p.id, logLine({ ...s, running: false, error: err.message, finishedAt: new Date().toISOString() }, `Stopped: ${err.message}`));
      return done({ stopped: err.message });
    }
    // Re-read: the user may have stopped autopilot meanwhile.
    const fresh = await db.query.projects.findFirst({ where: eq(projects.id, p.id), columns: { autopilot: true } });
    if (!fresh?.autopilot?.running) return done({ stopped: true });
    await save(db, p.id, result.state);
    return result.delayMs == null ? done({ finished: result.state.step }) : reschedule(result.delayMs);
  },
  async onFailed({ db, payload, error }) {
    await stopAutopilot(db, payload.projectId, `Autopilot error: ${error.message}`);
  },
};

