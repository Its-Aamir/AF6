/**
 * Pipeline orchestration service. Every status change goes through the pure
 * state machine; every long operation is enqueued in the same transaction.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { resolutionFor, type ProjectStatus, type Script } from '../../shared/schemas';
import { nextProjectStatus, stageRank, type ProjectStep } from '../../shared/stateMachines';
import type { Db, Tx } from '../db/client';
import { assets, generations, projects, scenes, type ProjectRow } from '../db/schema';
import { AppError, notFound } from '../errors';
import { findVoice, resolveModel } from '../providers/registry';
import { enqueue } from '../queue/queue';
import { buildCaptionCues } from './captions';
import { assertWithinBudget } from './costs';
import { createGeneration } from './generation';
import { assembleTimeline } from './timeline';

export async function lockProject(tx: Tx, projectId: string): Promise<ProjectRow> {
  const [p] = await tx.select().from(projects).where(eq(projects.id, projectId)).for('update');
  if (!p) throw notFound('Project');
  if (p.archivedAt) throw new AppError('INVALID_STATE', 'Project is archived');
  return p;
}

export async function setStatus(tx: Tx, projectId: string, status: ProjectStatus, extra: Partial<typeof projects.$inferInsert> = {}): Promise<void> {
  await tx.update(projects).set({ status, updatedAt: new Date(), ...extra }).where(eq(projects.id, projectId));
}

async function lockedSceneCount(tx: Tx, projectId: string): Promise<number> {
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(scenes).where(and(eq(scenes.projectId, projectId), eq(scenes.locked, true)));
  return r.n;
}

async function sceneCount(tx: Tx, projectId: string, withAssets = false): Promise<number> {
  const where = withAssets ? and(eq(scenes.projectId, projectId), isNotNull(scenes.selectedAssetId)) : eq(scenes.projectId, projectId);
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(scenes).where(where);
  return r.n;
}

/** Guard destructive rewinds: require explicit confirmation, refuse if locked scenes would be discarded. */
async function guardRewind(tx: Tx, p: ProjectRow, step: 'script' | 'narration' | 'segment', confirmReset: boolean) {
  const nScenes = await sceneCount(tx, p.id);
  const discards =
    step === 'script' ? !!p.narrationAssetId || nScenes > 0
      : step === 'narration' ? nScenes > 0
        : (await sceneCount(tx, p.id, true)) > 0;
  if (!discards) return;
  if (nScenes > 0 && (await lockedSceneCount(tx, p.id)) > 0) {
    throw new AppError('INVALID_STATE', 'This would discard locked scenes. Unlock them first.');
  }
  if (!confirmReset) {
    const what = step === 'script' ? 'narration, scenes and timeline' : step === 'narration' ? 'current scenes and timeline' : 'current scenes and their visuals';
    throw new AppError('CONFLICT', `This will replace the ${what}. Confirm to continue.`, { details: { requiresConfirmation: true } });
  }
}

/** Clears data that depends on an earlier step. Called when the earlier step's new result is committed. */
export async function resetDownstream(tx: Tx, projectId: string, from: 'script' | 'narration' | 'segment'): Promise<void> {
  await tx.delete(scenes).where(eq(scenes.projectId, projectId));
  const base = { timeline: null, qaReport: null, finalRenderAssetId: null, updatedAt: new Date() };
  if (from === 'segment') {
    await tx.update(projects).set(base).where(eq(projects.id, projectId));
    return;
  }
  const p = await tx.query.projects.findFirst({ where: eq(projects.id, projectId), columns: { captions: true } });
  await tx.update(projects).set({
    ...base,
    narrationAssetId: null, narrationDurationSec: null, narrationWords: null, narrationTimingSource: null,
    captions: { ...p!.captions, cues: [], generatedAt: null },
  }).where(eq(projects.id, projectId));
}

async function startStep(tx: Tx, p: ProjectRow, step: ProjectStep): Promise<ProjectStatus> {
  const next = nextProjectStatus(p.status as ProjectStatus, { type: 'START', step });
  await setStatus(tx, p.id, next, { resumeStatus: p.status, lastError: null });
  return next;
}

/** Recompute derived status after anything that changes scenes/audio/captions. */
export async function markTimelineStale(tx: Tx, projectId: string): Promise<void> {
  const p = await tx.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!p) return;
  const total = await sceneCount(tx, projectId);
  const ready = await sceneCount(tx, projectId, true);
  const next = nextProjectStatus(p.status as ProjectStatus, { type: 'TIMELINE_STALE', allAssetsReady: total > 0 && total === ready });
  if (next !== p.status) await setStatus(tx, projectId, next);
}

/** After scene generations settle: producing → assets_ready | planned. */
export async function settleProjectAssets(tx: Tx, projectId: string): Promise<void> {
  const p = await tx.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!p) return;
  const [active] = await tx.select({ n: sql<number>`count(*)::int` }).from(generations)
    .where(and(eq(generations.projectId, projectId), inArray(generations.capability, ['image', 'video']), inArray(generations.status, ['pending', 'submitted', 'running'])));
  if (active.n > 0) return;
  const total = await sceneCount(tx, projectId);
  const ready = await sceneCount(tx, projectId, true);
  if (stageRank(p.status as ProjectStatus) < stageRank('planned')) return;
  const next = nextProjectStatus(p.status as ProjectStatus, { type: 'ASSETS_SETTLED', allAssetsReady: total > 0 && total === ready });
  if (next !== p.status) await setStatus(tx, projectId, next);
}

// ── Steps ────────────────────────────────────────────────────────────────────

export async function startScript(db: Db, projectId: string, confirmReset = false) {
  return db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    await guardRewind(tx, p, 'script', confirmReset);
    await startStep(tx, p, 'script');
    return (await enqueue(tx, { type: 'script.generate', payload: { projectId }, projectId, dedupeKey: `script:${projectId}` })).job;
  });
}

export async function editScript(db: Db, projectId: string, input: { sections: Script['sections']; title?: string }, confirmReset = false) {
  return db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    if (!p.script) throw new AppError('INVALID_STATE', 'Generate a script first.');
    const status = p.status as ProjectStatus;
    if (stageRank(status) < stageRank('scripted') || ['scripting', 'narrating', 'segmenting', 'planning', 'producing', 'qa_running', 'rendering'].includes(status)) {
      throw new AppError('INVALID_STATE', `Cannot edit the script while ${status.replace('_', ' ')}.`);
    }
    await guardRewind(tx, p, 'script', confirmReset);
    const script: Script = { ...p.script, title: input.title ?? p.script.title, sections: input.sections, hook: input.sections[0].narration.split(/(?<=[.!?])\s/)[0].slice(0, 600) };
    if (p.narrationAssetId || stageRank(status) > stageRank('scripted')) await resetDownstream(tx, projectId, 'script');
    await setStatus(tx, projectId, 'scripted', { script, lastError: null });
    return script;
  });
}

export async function startNarration(db: Db, projectId: string, confirmReset = false) {
  return db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    if (!p.script) throw new AppError('INVALID_STATE', 'Generate the script first.');
    await guardRewind(tx, p, 'narration', confirmReset);
    if (p.voiceoverAssetId) {
      // User-supplied voiceover: align the script to it instead of synthesising speech.
      await startStep(tx, p, 'narration');
      return (await enqueue(tx, { type: 'narration.align', payload: { projectId }, projectId, dedupeKey: `narration:${projectId}` })).job;
    }
    const ref = p.recipeSnapshot.defaults.tts;
    const voice = findVoice(p.voiceId);
    if (!voice) throw new AppError('VALIDATION_ERROR', `Voice "${p.voiceId}" is not available. Pick a voice on the Audio tab (connect ElevenLabs for real voices).`);
    const providerId = voice.provider.id;
    const ttsModel = providerId === ref.provider ? ref.model : voice.provider.models.find((m) => m.capability === 'tts')?.id;
    if (!ttsModel) throw new AppError('PROVIDER_NOT_AVAILABLE', `${voice.provider.displayName} has no enabled TTS model. Enable one on the Providers page.`);
    const text = p.script.sections.map((s) => s.narration).join('\n\n');
    const request = { capability: 'tts' as const, model: ttsModel, prompt: `Narration for "${p.title}"`, text, voiceId: p.voiceId, wordsPerMinute: p.recipeSnapshot.wordsPerMinute };
    const { provider } = resolveModel('tts', providerId, ttsModel);
    const estimate = provider.estimateCost(request);
    await assertWithinBudget(tx, projectId, estimate.amountUsd);
    await startStep(tx, p, 'narration');
    const gen = await createGeneration(tx, { projectId, request, provider: provider.id, estimate });
    return (await enqueue(tx, { type: 'narration.generate', payload: { projectId, generationId: gen.id }, projectId, dedupeKey: `narration:${projectId}` })).job;
  });
}

export async function startSegment(db: Db, projectId: string, confirmReset = false) {
  return db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    await guardRewind(tx, p, 'segment', confirmReset);
    await startStep(tx, p, 'segment');
    return (await enqueue(tx, { type: 'scenes.segment', payload: { projectId }, projectId, dedupeKey: `segment:${projectId}` })).job;
  });
}

export async function startPlan(db: Db, projectId: string) {
  return db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    const [busy] = await tx.select({ n: sql<number>`count(*)::int` }).from(scenes).where(and(eq(scenes.projectId, projectId), inArray(scenes.status, ['queued', 'generating'])));
    if (busy.n > 0) throw new AppError('INVALID_STATE', 'Scenes are still generating.');
    await startStep(tx, p, 'plan');
    return (await enqueue(tx, { type: 'visuals.plan', payload: { projectId }, projectId, dedupeKey: `plan:${projectId}` })).job;
  });
}

export async function requestMusic(db: Db, projectId: string) {
  return db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    if (!p.narrationDurationSec) throw new AppError('INVALID_STATE', 'Generate narration first: music length follows the narration.');
    const ref = p.recipeSnapshot.defaults.music;
    const request = { capability: 'music' as const, model: ref.model, prompt: `${p.music.mood || 'ambient'} background music`, durationSec: Math.ceil(p.narrationDurationSec + 1.5) };
    const { provider } = resolveModel('music', ref.provider, ref.model);
    const estimate = provider.estimateCost(request);
    await assertWithinBudget(tx, projectId, estimate.amountUsd);
    const gen = await createGeneration(tx, { projectId, request, provider: provider.id, estimate });
    await tx.update(projects).set({ music: { ...p.music, enabled: true }, updatedAt: new Date() }).where(eq(projects.id, projectId));
    return (await enqueue(tx, { type: 'music.generate', payload: { projectId, generationId: gen.id }, projectId, dedupeKey: `music:${projectId}` })).job;
  });
}

/** Deterministic and fast: runs synchronously. */
export async function generateCaptions(db: Db, projectId: string) {
  return db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    if (!p.narrationWords?.length) throw new AppError('INVALID_STATE', 'Generate narration first: captions come from narration timing.');
    const cues = buildCaptionCues(p.narrationWords, p.captions.maxChars);
    const captions = { ...p.captions, enabled: true, cues, generatedAt: new Date().toISOString() };
    await tx.update(projects).set({ captions, updatedAt: new Date() }).where(eq(projects.id, projectId));
    await markTimelineStale(tx, projectId);
    return captions;
  });
}

/** Deterministic and fast: runs synchronously. */
export async function assembleProjectTimeline(db: Db, projectId: string) {
  return db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    const sceneRows = await tx.select().from(scenes).where(eq(scenes.projectId, projectId)).orderBy(scenes.index);
    const ids = sceneRows.map((s) => s.selectedAssetId).filter((x): x is string => !!x);
    const assetRows = ids.length ? await tx.select().from(assets).where(inArray(assets.id, ids)) : [];
    const next = nextProjectStatus(p.status as ProjectStatus, { type: 'START', step: 'assemble' });
    const timeline = assembleTimeline(p, sceneRows, new Map(assetRows.map((a) => [a.id, a])));
    await setStatus(tx, projectId, next, { timeline, qaReport: null, lastError: null });
    return timeline;
  });
}

export async function startQa(db: Db, projectId: string) {
  return db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    await startStep(tx, p, 'qa');
    return (await enqueue(tx, { type: 'qa.run', payload: { projectId }, projectId, dedupeKey: `qa:${projectId}` })).job;
  });
}

export async function startRender(db: Db, projectId: string, preset: 'draft' | 'final' | 'hd') {
  return db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    if (!p.timeline) throw new AppError('INVALID_STATE', 'Assemble the timeline first.');
    await startStep(tx, p, 'render');
    return (await enqueue(tx, { type: 'render.final', payload: { projectId, preset }, projectId, dedupeKey: `render:${projectId}` })).job;
  });
}

export async function requestPackage(db: Db, projectId: string) {
  return db.transaction(async (tx) => {
    const p = await lockProject(tx, projectId);
    if (!p.script) throw new AppError('INVALID_STATE', 'Nothing to package yet: generate a script first.');
    return (await enqueue(tx, { type: 'package.export', payload: { projectId }, projectId, dedupeKey: `package:${projectId}` })).job;
  });
}

export async function requestVoicePreview(db: Db, voiceId: string) {
  const found = findVoice(voiceId);
  if (!found) throw notFound('Voice');
  const model = found.provider.models.find((m) => m.capability === 'tts');
  if (!model) throw new AppError('PROVIDER_NOT_AVAILABLE', 'Voice provider has no TTS model');
  const request = { capability: 'tts' as const, model: model.id, prompt: `Voice preview ${voiceId}`, text: `Hello. This is the ${found.voice.label} voice. Every scene in your video follows the timing of this narration.`, voiceId, wordsPerMinute: 150 };
  const { provider } = resolveModel('tts', found.provider.id, model.id);
  return db.transaction(async (tx) => {
    const gen = await createGeneration(tx, { projectId: null, request, provider: provider.id, estimate: provider.estimateCost(request) });
    return (await enqueue(tx, { type: 'voice.preview', payload: { voiceId, generationId: gen.id }, dedupeKey: `voice:${voiceId}` })).job;
  });
}

export function renderResolution(p: ProjectRow, preset: 'draft' | 'final' | 'hd') {
  return resolutionFor(p.recipeSnapshot.aspectRatio, preset);
}
