/** Scene-level operations for the storyboard. */
import { and, eq, inArray } from 'drizzle-orm';
import type { Capability, ProjectStatus, SceneStatus, VisualStrategy } from '../../shared/schemas';
import { nextProjectStatus, nextSceneStatus, whyCannotStart } from '../../shared/stateMachines';
import type { Db, Tx } from '../db/client';
import { assets, generations, projects, scenes, type ProjectRow, type SceneRow } from '../db/schema';
import { AppError, notFound } from '../errors';
import { resolveModel } from '../providers/registry';
import type { GenerationRequest } from '../providers/types';
import { enqueue } from '../queue/queue';
import { assertWithinBudget, round4 } from './costs';
import { createGeneration } from './generation';
import { lockProject, markTimelineStale, renderResolution, setStatus, settleProjectAssets } from './pipeline';
import { adjustSceneDuration, wordsText } from './segmentation';

const ACTIVE = ['pending', 'submitted', 'running'];

export function capabilityFor(strategy: VisualStrategy | string | null): Capability {
  return strategy === 'ai_video' ? 'video' : 'image';
}

async function lockScene(tx: Tx, sceneId: string): Promise<{ scene: SceneRow; project: ProjectRow }> {
  const s0 = await tx.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { projectId: true } });
  if (!s0) throw notFound('Scene');
  const project = await lockProject(tx, s0.projectId);
  const [scene] = await tx.select().from(scenes).where(eq(scenes.id, sceneId)).for('update');
  return { scene, project };
}

function buildRequest(project: ProjectRow, scene: SceneRow, variant: number): { request: GenerationRequest; provider: string } {
  if (!scene.prompt || !scene.provider || !scene.model) throw new AppError('INVALID_STATE', `Scene ${scene.index} has no visual brief yet — run visual planning first.`);
  const capability = capabilityFor(scene.visualStrategy);
  const { model } = resolveModel(capability, scene.provider, scene.model);
  const { width, height } = renderResolution(project, 'final');
  const dur = scene.endSec - scene.startSec;
  const request: GenerationRequest = {
    capability, model: model.id, prompt: scene.prompt, negativePrompt: scene.negativePrompt || undefined,
    width, height, seed: Date.now() % 100000 + variant * 7919, references: scene.references,
    label: `Scene ${scene.index}${variant ? ` alt ${variant + 1}` : ''}`,
    ...(capability === 'video' ? { durationSec: Math.min(Math.ceil(dur * 10) / 10, model.maxDurationSec ?? dur) } : {}),
  };
  return { request, provider: scene.provider };
}

async function enqueueSceneGenerations(tx: Tx, project: ProjectRow, scene: SceneRow, count: number) {
  const nextScene = nextSceneStatus({ status: scene.status as SceneStatus, locked: scene.locked, hasAsset: !!scene.selectedAssetId }, { type: 'ENQUEUE' });
  const jobsOut = [];
  for (let i = 0; i < count; i++) {
    const { request, provider } = buildRequest(project, scene, i);
    const { provider: p } = resolveModel(request.capability, provider, request.model);
    const gen = await createGeneration(tx, { projectId: project.id, sceneId: scene.id, request, provider, estimate: p.estimateCost(request) });
    const { job } = await enqueue(tx, { type: 'scene.generate', payload: { generationId: gen.id, autoSelect: count === 1 }, projectId: project.id, sceneId: scene.id });
    jobsOut.push(job);
  }
  await tx.update(scenes).set({ status: nextScene, error: null, updatedAt: new Date() }).where(eq(scenes.id, scene.id));
  return jobsOut;
}

async function enterProducing(tx: Tx, project: ProjectRow) {
  const status = project.status as ProjectStatus;
  if (status === 'producing') return;
  const next = nextProjectStatus(status, { type: 'START', step: 'assets' });
  await setStatus(tx, project.id, next, { resumeStatus: status, lastError: null });
}

function estimateScene(project: ProjectRow, scene: SceneRow, count: number): number {
  const { request, provider } = buildRequest(project, scene, 0);
  return resolveModel(request.capability, provider, request.model).provider.estimateCost(request).amountUsd * count;
}

export async function generateScene(db: Db, sceneId: string, alternatives: number) {
  return db.transaction(async (tx) => {
    const { scene, project } = await lockScene(tx, sceneId);
    const why = whyCannotStart(project.status as ProjectStatus, 'assets');
    if (why) throw new AppError('INVALID_STATE', `Cannot generate: ${why}.`);
    await assertWithinBudget(tx, project.id, estimateScene(project, scene, alternatives));
    const out = await enqueueSceneGenerations(tx, project, scene, alternatives);
    await enterProducing(tx, project);
    return out;
  });
}

export async function generateAllScenes(db: Db, projectId: string) {
  return db.transaction(async (tx) => {
    const project = await lockProject(tx, projectId);
    const why = whyCannotStart(project.status as ProjectStatus, 'assets');
    if (why) throw new AppError('INVALID_STATE', `Cannot generate: ${why}.`);
    const rows = await tx.select().from(scenes).where(eq(scenes.projectId, projectId)).orderBy(scenes.index).for('update');
    const todo = rows.filter((s) => !s.locked && !s.selectedAssetId && s.status !== 'queued' && s.status !== 'generating' && s.status !== 'pending');
    if (!todo.length) throw new AppError('INVALID_STATE', rows.some((s) => s.status === 'pending') ? 'Plan visuals first.' : 'Every unlocked scene already has a visual or is generating.');
    const total = round4(todo.reduce((acc, s) => acc + estimateScene(project, s, 1), 0));
    await assertWithinBudget(tx, projectId, total);
    const out = [];
    for (const s of todo) out.push(...(await enqueueSceneGenerations(tx, project, s, 1)));
    await enterProducing(tx, project);
    return { jobs: out, estimatedUsd: total };
  });
}

export async function estimateAllScenes(db: Db, projectId: string): Promise<{ scenes: number; estimatedUsd: number }> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw notFound('Project');
  const rows = await db.select().from(scenes).where(eq(scenes.projectId, projectId));
  const todo = rows.filter((s) => !s.locked && !s.selectedAssetId && s.prompt && s.status !== 'queued' && s.status !== 'generating');
  let total = 0;
  for (const s of todo) {
    try { total += estimateScene(project, s, 1); } catch { /* unusable provider → surfaced when generating */ }
  }
  return { scenes: todo.length, estimatedUsd: round4(total) };
}

export async function updateScene(db: Db, sceneId: string, patch: { prompt?: string; negativePrompt?: string; visualStrategy?: VisualStrategy; provider?: string; model?: string; references?: string[]; locked?: boolean }) {
  return db.transaction(async (tx) => {
    const { scene, project } = await lockScene(tx, sceneId);
    const { locked, ...edits } = patch;
    const set: Partial<typeof scenes.$inferInsert> = { updatedAt: new Date() };
    if (Object.keys(edits).length) {
      nextSceneStatus({ status: scene.status as SceneStatus, locked: scene.locked && locked !== false, hasAsset: !!scene.selectedAssetId }, { type: 'EDIT' });
      const strategy = edits.visualStrategy ?? (scene.visualStrategy as VisualStrategy | null) ?? 'ai_image';
      const cap = capabilityFor(strategy);
      let providerId = edits.provider ?? scene.provider ?? project.recipeSnapshot.defaults[cap].provider;
      let modelId = edits.model ?? scene.model ?? project.recipeSnapshot.defaults[cap].model;
      if (edits.visualStrategy && !edits.model) {
        // Strategy switch: keep the model if compatible, else fall back to the recipe default for that capability (explicit, visible).
        try { resolveModel(cap, providerId, modelId); } catch { providerId = project.recipeSnapshot.defaults[cap].provider; modelId = project.recipeSnapshot.defaults[cap].model; }
      }
      resolveModel(cap, providerId, modelId); // throws PROVIDER_NOT_AVAILABLE if unusable
      Object.assign(set, {
        visualStrategy: strategy, provider: providerId, model: modelId,
        ...(edits.prompt !== undefined ? { prompt: edits.prompt } : {}),
        ...(edits.negativePrompt !== undefined ? { negativePrompt: edits.negativePrompt } : {}),
        ...(edits.references !== undefined ? { references: edits.references } : {}),
      });
    }
    if (locked !== undefined) set.locked = locked;
    const [row] = await tx.update(scenes).set(set).where(eq(scenes.id, sceneId)).returning();
    return row;
  });
}

export async function changeSceneDuration(db: Db, sceneId: string, durationSec: number) {
  return db.transaction(async (tx) => {
    const { scene, project } = await lockScene(tx, sceneId);
    const words = project.narrationWords;
    if (!words?.length || !project.narrationDurationSec) throw new AppError('INVALID_STATE', 'Narration timing missing.');
    const all = await tx.select().from(scenes).where(eq(scenes.projectId, project.id)).orderBy(scenes.index).for('update');
    const i = all.findIndex((s) => s.id === sceneId);
    const neighbourIsNext = i < all.length - 1;
    const neighbour = neighbourIsNext ? all[i + 1] : all[i - 1];
    if (!neighbour) throw new AppError('INVALID_STATE', 'A single scene always spans the full narration.');
    for (const s of [scene, neighbour]) {
      if (s.locked) throw new AppError('INVALID_STATE', `Scene ${s.index} is locked.`);
      if (s.status === 'queued' || s.status === 'generating') throw new AppError('INVALID_STATE', `Scene ${s.index} is generating.`);
    }
    const span = (x: SceneRow) => ({ wordStart: x.wordStart, wordEnd: x.wordEnd, start: x.startSec, end: x.endSec });
    const res = adjustSceneDuration(words, project.narrationDurationSec, span(scene), span(neighbour), neighbourIsNext, durationSec);
    for (const [row, span] of [[scene, res.scene], [neighbour, res.neighbour]] as const) {
      await tx.update(scenes).set({
        startSec: span.start, endSec: span.end, wordStart: span.wordStart, wordEnd: span.wordEnd,
        narration: wordsText(words, span.wordStart, span.wordEnd), updatedAt: new Date(),
      }).where(eq(scenes.id, row.id));
    }
    await markTimelineStale(tx, project.id);
    return { sceneDurationSec: res.scene.end - res.scene.start, neighbourIndex: neighbour.index };
  });
}

/** Select one of the scene's candidates, or attach a library/uploaded asset (replace). */
export async function selectSceneAsset(db: Db, sceneId: string, assetId: string) {
  return db.transaction(async (tx) => {
    const { scene, project } = await lockScene(tx, sceneId);
    const asset = await tx.query.assets.findFirst({ where: eq(assets.id, assetId) });
    if (!asset) throw notFound('Asset');
    if (asset.mediaType !== 'image' && asset.mediaType !== 'video') throw new AppError('VALIDATION_ERROR', 'Only images and videos can be used as scene visuals.');
    if (asset.projectId && asset.projectId !== project.id) throw new AppError('VALIDATION_ERROR', 'Asset belongs to another project.');
    const next = nextSceneStatus({ status: scene.status as SceneStatus, locked: scene.locked, hasAsset: !!scene.selectedAssetId }, { type: 'REPLACE' });
    let useId = asset.id;
    if (asset.sceneId !== scene.id) {
      // Attach a scene-scoped record pointing at the same stored file (keeps library entry intact).
      const [copy] = await tx.insert(assets).values({
        projectId: project.id, sceneId: scene.id, generationId: null, kind: asset.kind, mediaType: asset.mediaType, source: asset.source,
        label: asset.label || `Replacement for scene ${scene.index}`, storageKey: asset.storageKey, mime: asset.mime, bytes: asset.bytes,
        durationSec: asset.durationSec, width: asset.width, height: asset.height, metadata: { ...asset.metadata, replacedFrom: asset.id },
      }).returning();
      useId = copy.id;
    }
    const [activeGen] = await tx.select({ id: generations.id }).from(generations).where(and(eq(generations.sceneId, scene.id), inArray(generations.status, ACTIVE))).limit(1);
    await tx.update(scenes).set({ selectedAssetId: useId, status: activeGen ? scene.status : next, error: null, qualityStatus: 'unchecked', updatedAt: new Date() }).where(eq(scenes.id, sceneId));
    await settleProjectAssets(tx, project.id);
    await markTimelineStale(tx, project.id);
    return useId;
  });
}

/** Derive scene status from its generations after one finishes. */
export async function settleScene(tx: Tx, sceneId: string, lastError?: string | null): Promise<void> {
  const scene = await tx.query.scenes.findFirst({ where: eq(scenes.id, sceneId) });
  if (!scene) return;
  const [active] = await tx.select({ id: generations.id, status: generations.status }).from(generations).where(and(eq(generations.sceneId, sceneId), inArray(generations.status, ACTIVE))).limit(1);
  const status = active ? (active.status === 'pending' ? 'queued' : 'generating') : scene.selectedAssetId ? 'generated' : scene.prompt ? 'failed' : 'pending';
  await tx.update(scenes).set({ status, ...(lastError !== undefined ? { error: lastError } : {}), updatedAt: new Date() }).where(eq(scenes.id, sceneId));
}
