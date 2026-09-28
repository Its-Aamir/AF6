import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { CreateProjectInput, JobType } from '../../shared/schemas';
import { isBusy } from '../../shared/stateMachines';
import type { Db } from '../db/client';
import { assets, costEntries, generations, jobs, projects, recipes, scenes, type JobRow } from '../db/schema';
import { AppError, notFound } from '../errors';
import { findVoice } from '../providers/registry';
import { failJob } from '../queue/queue';
import { getHandler } from '../jobs/registry';
import { projectCostSummary } from './costs';
import {
  requestMusic, requestPackage, requestVoicePreview, startNarration, startPlan, startQa, startRender, startScript, startSegment,
} from './pipeline';
import { generateScene } from './scenes';
import { sanitizeText } from '../llm/structured';
import { getSettings } from './settings';
import { timelineIsCurrent } from './timeline';
import { MAX_SCRIPT_CHARS } from '../../shared/schemas';

export async function createProject(db: Db, input: CreateProjectInput) {
  const recipe = await db.query.recipes.findFirst({ where: eq(recipes.id, input.recipeId) });
  if (!recipe) throw new AppError('VALIDATION_ERROR', 'Selected Channel Recipe does not exist');
  const settings = await getSettings(db);
  const c = recipe.config;
  const [row] = await db.insert(projects).values({
    title: input.title,
    inputMode: input.inputMode,
    topic: input.inputMode === 'topic' ? sanitizeText(input.topic, 1000) : '',
    sourceScript: input.inputMode === 'script' ? sanitizeText(input.sourceScript, MAX_SCRIPT_CHARS) : '',
    recipeId: recipe.id,
    recipeName: recipe.name,
    recipeSnapshot: c,
    voiceId: findVoice(c.voiceId) ? c.voiceId : 'mock-narrator-warm',
    music: { enabled: c.music.enabled, mood: c.music.mood, volume: c.music.volume, duck: true },
    captions: { enabled: c.captions.enabled, position: c.captions.position, maxChars: c.captions.maxChars, cues: [], generatedAt: null },
    budgetUsd: input.budgetUsd ?? settings.defaultBudgetUsd,
  }).returning();
  return row;
}

export async function listProjects(db: Db) {
  const rows = await db.select().from(projects).where(isNull(projects.archivedAt)).orderBy(desc(projects.updatedAt)).limit(200);
  const ids = rows.map((r) => r.id);
  const counts = ids.length
    ? await db.select({ projectId: scenes.projectId, n: sql<number>`count(*)::int`, ready: sql<number>`count(${scenes.selectedAssetId})::int` }).from(scenes).where(inArray(scenes.projectId, ids)).groupBy(scenes.projectId)
    : [];
  const spend = ids.length
    ? await db.select({ projectId: costEntries.projectId, v: sql<string>`sum(${costEntries.amountUsd})` }).from(costEntries).where(and(inArray(costEntries.projectId, ids), eq(costEntries.kind, 'actual'))).groupBy(costEntries.projectId)
    : [];
  const active = ids.length
    ? await db.select({ projectId: jobs.projectId, n: sql<number>`count(*)::int` }).from(jobs).where(and(inArray(jobs.projectId, ids), inArray(jobs.status, ['queued', 'running']))).groupBy(jobs.projectId)
    : [];
  const thumbs = ids.length
    ? await db.select({ projectId: scenes.projectId, assetId: scenes.selectedAssetId, mediaType: assets.mediaType }).from(scenes)
      .innerJoin(assets, eq(assets.id, scenes.selectedAssetId)).where(and(inArray(scenes.projectId, ids), eq(scenes.index, 1)))
    : [];
  return rows.map((p) => ({
    id: p.id, title: p.title, status: p.status, recipeName: p.recipeName, aspectRatio: p.recipeSnapshot.aspectRatio,
    narrationDurationSec: p.narrationDurationSec, lastError: p.lastError, createdAt: p.createdAt, updatedAt: p.updatedAt, budgetUsd: p.budgetUsd,
    scenes: counts.find((c) => c.projectId === p.id)?.n ?? 0,
    scenesReady: counts.find((c) => c.projectId === p.id)?.ready ?? 0,
    spentUsd: Number(spend.find((s) => s.projectId === p.id)?.v ?? 0),
    activeJobs: active.find((a) => a.projectId === p.id)?.n ?? 0,
    thumbnail: thumbs.find((t) => t.projectId === p.id) ?? null,
    hasRender: !!p.finalRenderAssetId,
  }));
}

/** Everything the studio needs, in one read. The browser keeps no authoritative state. */
export async function getProjectState(db: Db, projectId: string) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw notFound('Project');
  const [sceneRows, assetRows, genRows, jobRows, sceneCosts] = await Promise.all([
    db.select().from(scenes).where(eq(scenes.projectId, projectId)).orderBy(scenes.index),
    db.select().from(assets).where(eq(assets.projectId, projectId)).orderBy(desc(assets.createdAt)),
    db.select().from(generations).where(eq(generations.projectId, projectId)).orderBy(desc(generations.createdAt)),
    db.select().from(jobs).where(eq(jobs.projectId, projectId)).orderBy(desc(jobs.createdAt)).limit(60),
    db.select({ sceneId: costEntries.sceneId, v: sql<string>`sum(${costEntries.amountUsd})` }).from(costEntries)
      .where(and(eq(costEntries.projectId, projectId), eq(costEntries.kind, 'actual'))).groupBy(costEntries.sceneId),
  ]);
  const costs = await projectCostSummary(db, projectId, project.budgetUsd);
  const byCapability = await db.select({ capability: costEntries.capability, v: sql<string>`sum(${costEntries.amountUsd})` }).from(costEntries)
    .where(and(eq(costEntries.projectId, projectId), eq(costEntries.kind, 'actual'))).groupBy(costEntries.capability);
  const scenesOut = sceneRows.map((s) => {
    const gens = genRows.filter((g) => g.sceneId === s.id);
    return {
      ...s,
      durationSec: Math.round((s.endSec - s.startSec) * 1000) / 1000,
      costUsd: Number(sceneCosts.find((c) => c.sceneId === s.id)?.v ?? 0),
      candidates: assetRows.filter((a) => a.sceneId === s.id && (a.mediaType === 'image' || a.mediaType === 'video')),
      activeGenerations: gens.filter((g) => ['pending', 'submitted', 'running'].includes(g.status)),
      lastGeneration: gens[0] ?? null,
    };
  });
  const { sourceScript, ...rest } = project;
  return {
    project: { ...rest, sourceScriptLength: sourceScript.length, sourceScript, busy: isBusy(project.status as never), timelineCurrent: timelineIsCurrent(project, sceneRows) },
    scenes: scenesOut,
    assets: assetRows,
    generations: genRows.filter((g) => !g.sceneId).slice(0, 20),
    jobs: jobRows,
    activeJobs: jobRows.filter((j) => j.status === 'queued' || j.status === 'running').length,
    costs: { ...costs, byCapability: byCapability.map((b) => ({ capability: b.capability, usd: Number(b.v) })) },
  };
}

export async function archiveProject(db: Db, projectId: string) {
  const active = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.projectId, projectId), inArray(jobs.status, ['queued', 'running'])));
  if (active.length) throw new AppError('INVALID_STATE', 'Cancel or wait for running jobs before deleting this project.');
  const res = await db.update(projects).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(projects.id, projectId)).returning({ id: projects.id });
  if (!res.length) throw notFound('Project');
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

export async function listJobs(db: Db, filter: { status?: string; projectId?: string }) {
  const where = [];
  if (filter.status === 'active') where.push(inArray(jobs.status, ['queued', 'running']));
  else if (filter.status) where.push(eq(jobs.status, filter.status));
  if (filter.projectId) where.push(eq(jobs.projectId, filter.projectId));
  const rows = await db.select({ job: jobs, projectTitle: projects.title }).from(jobs).leftJoin(projects, eq(projects.id, jobs.projectId))
    .where(where.length ? and(...where) : undefined).orderBy(desc(jobs.createdAt)).limit(200);
  return rows.map((r) => ({ ...r.job, projectTitle: r.projectTitle }));
}

export async function cancelJob(db: Db, jobId: string): Promise<JobRow> {
  const job = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
  if (!job) throw notFound('Job');
  if (job.status !== 'queued' && job.status !== 'running') throw new AppError('INVALID_STATE', `Job is already ${job.status}.`);
  const leaseExpired = job.status === 'running' && (!job.lockedUntil || job.lockedUntil.getTime() < Date.now());
  if (job.status === 'queued' || leaseExpired) {
    const err = new AppError('CANCELLED', 'Cancelled by user');
    await failJob(db, { ...job, cancelRequested: true }, null, err);
    const handler = getHandler(job.type);
    const parsed = handler?.payloadSchema.safeParse(job.payload);
    if (handler?.onFailed && parsed?.success) await handler.onFailed({ job, payload: parsed.data, db, error: err });
  } else {
    await db.update(jobs).set({ cancelRequested: true, progressMessage: 'Cancelling…', updatedAt: new Date() }).where(eq(jobs.id, jobId));
  }
  return (await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) }))!;
}

/** Retry = re-issue the same domain action (goes through state machine, budget and dedupe again). */
export async function retryJob(db: Db, jobId: string): Promise<JobRow | JobRow[]> {
  const job = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
  if (!job) throw notFound('Job');
  if (job.status !== 'failed' && job.status !== 'cancelled') throw new AppError('INVALID_STATE', 'Only failed or cancelled jobs can be retried.');
  const p = job.payload as { projectId?: string; preset?: 'draft' | 'final'; voiceId?: string };
  const pid = job.projectId ?? p.projectId;
  const need = () => { if (!pid) throw new AppError('INVALID_STATE', 'Job has no project'); return pid; };
  switch (job.type as JobType) {
    case 'script.generate': return startScript(db, need(), true);
    case 'narration.generate': return startNarration(db, need(), true);
    case 'scenes.segment': return startSegment(db, need(), true);
    case 'visuals.plan': return startPlan(db, need());
    case 'scene.generate': {
      if (!job.sceneId) throw new AppError('INVALID_STATE', 'The scene for this job no longer exists.');
      return generateScene(db, job.sceneId, 1);
    }
    case 'music.generate': return requestMusic(db, need());
    case 'qa.run': return startQa(db, need());
    case 'render.final': return startRender(db, need(), p.preset ?? 'final');
    case 'package.export': return requestPackage(db, need());
    case 'voice.preview': return requestVoicePreview(db, p.voiceId ?? '');
  }
}

// ── Dashboard / costs ────────────────────────────────────────────────────────

export async function dashboard(db: Db) {
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const [projCount] = await db.select({ n: sql<number>`count(*)::int` }).from(projects).where(isNull(projects.archivedAt));
  const [rendered] = await db.select({ n: sql<number>`count(*)::int` }).from(projects).where(and(isNull(projects.archivedAt), sql`${projects.finalRenderAssetId} is not null`));
  const [month] = await db.select({ v: sql<string>`coalesce(sum(${costEntries.amountUsd}),0)` }).from(costEntries).where(and(eq(costEntries.kind, 'actual'), gte(costEntries.createdAt, monthStart)));
  const [failed24] = await db.select({ n: sql<number>`count(*)::int` }).from(jobs).where(and(eq(jobs.status, 'failed'), gte(jobs.updatedAt, new Date(Date.now() - 86_400_000))));
  const activeJobs = await listJobs(db, { status: 'active' });
  const recent = (await listProjects(db)).slice(0, 6);
  return {
    stats: { projects: projCount.n, rendered: rendered.n, spendThisMonthUsd: Number(month.v), activeJobs: activeJobs.length, failedJobs24h: failed24.n },
    recentProjects: recent,
    activeJobs: activeJobs.slice(0, 10),
  };
}

export async function costsOverview(db: Db) {
  const byProject = await db.select({ projectId: costEntries.projectId, title: projects.title, v: sql<string>`sum(${costEntries.amountUsd})`, budget: projects.budgetUsd })
    .from(costEntries).leftJoin(projects, eq(projects.id, costEntries.projectId)).where(eq(costEntries.kind, 'actual')).groupBy(costEntries.projectId, projects.title, projects.budgetUsd);
  const byProvider = await db.select({ provider: costEntries.provider, model: costEntries.model, capability: costEntries.capability, v: sql<string>`sum(${costEntries.amountUsd})`, n: sql<number>`count(*)::int`, simulated: sql<boolean>`bool_and(${costEntries.simulated})` })
    .from(costEntries).where(eq(costEntries.kind, 'actual')).groupBy(costEntries.provider, costEntries.model, costEntries.capability);
  const ledger = await db.select({ entry: costEntries, title: projects.title }).from(costEntries).leftJoin(projects, eq(projects.id, costEntries.projectId)).orderBy(desc(costEntries.createdAt)).limit(200);
  const total = byProject.reduce((a, r) => a + Number(r.v), 0);
  return {
    totalUsd: total,
    byProject: byProject.map((r) => ({ projectId: r.projectId, title: r.title ?? '(library)', usd: Number(r.v), budgetUsd: r.budget })),
    byProvider: byProvider.map((r) => ({ ...r, usd: Number(r.v) })),
    ledger: ledger.map((r) => ({ ...r.entry, projectTitle: r.title })),
  };
}
