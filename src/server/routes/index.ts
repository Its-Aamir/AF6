import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  CreateProjectInputSchema, EditScriptInputSchema, GenerateSceneInputSchema, RecipeInputSchema, RenderInputSchema, SceneDurationInputSchema,
  SelectAssetInputSchema, UpdateProjectInputSchema, UpdateSceneInputSchema, UpdateSettingsInputSchema,
} from '../../shared/schemas';
import { getDb } from '../db/client';
import { assets, projects, recipes } from '../db/schema';
import { AppError, notFound } from '../errors';
import { checkMediaTooling, probe } from '../media/ffmpeg';
import { refreshConnections } from '../providers/connections';
import { listProviders } from '../providers/registry';
import { registerConnectionRoutes } from './connections';
import { createVideoThumbnail, ingestFile } from '../services/assets';
import {
  assembleProjectTimeline, editScript, generateCaptions, markTimelineStale, requestMusic, requestPackage, requestVoicePreview,
  startNarration, startPlan, startQa, startRender, startScript, startSegment,
} from '../services/pipeline';
import {
  archiveProject, cancelJob, costsOverview, createProject, dashboard, getProjectState, listJobs, listProjects, retryJob,
} from '../services/projects';
import { changeSceneDuration, estimateAllScenes, generateAllScenes, generateScene, selectSceneAsset, updateScene } from '../services/scenes';
import { getSettings, saveSettings } from '../services/settings';
import { getStorage } from '../storage/storage';

const Id = z.object({ id: z.string().uuid() });
const Confirm = z.object({ confirmReset: z.boolean().default(false) });
const params = (req: FastifyRequest) => Id.parse(req.params).id;
const body = <T extends z.ZodType>(schema: T, req: FastifyRequest): z.infer<T> => schema.parse(req.body ?? {});

/** Extension → media type, mime, and the ffprobe container formats we accept for it. */
const UPLOAD_TYPES: Record<string, { mediaType: 'image' | 'video' | 'audio'; mime: string; formats: string[] }> = {
  png: { mediaType: 'image', mime: 'image/png', formats: ['png_pipe'] },
  jpg: { mediaType: 'image', mime: 'image/jpeg', formats: ['jpeg_pipe'] },
  jpeg: { mediaType: 'image', mime: 'image/jpeg', formats: ['jpeg_pipe'] },
  webp: { mediaType: 'image', mime: 'image/webp', formats: ['webp_pipe'] },
  mp4: { mediaType: 'video', mime: 'video/mp4', formats: ['mov,mp4,m4a,3gp,3g2,mj2'] },
  mov: { mediaType: 'video', mime: 'video/quicktime', formats: ['mov,mp4,m4a,3gp,3g2,mj2'] },
  webm: { mediaType: 'video', mime: 'video/webm', formats: ['matroska,webm'] },
  wav: { mediaType: 'audio', mime: 'audio/wav', formats: ['wav'] },
  mp3: { mediaType: 'audio', mime: 'audio/mpeg', formats: ['mp3'] },
};

async function sendAsset(req: FastifyRequest, reply: FastifyReply, download: boolean) {
  const a = await getDb().query.assets.findFirst({ where: eq(assets.id, params(req)) });
  if (!a) throw notFound('Asset');
  const storage = getStorage();
  const st = await storage.stat(a.storageKey);
  if (!st) throw new AppError('NOT_FOUND', 'Asset file is missing from storage');
  const ext = a.storageKey.split('.').pop();
  const name = `${(a.label || a.kind).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || a.kind}${a.label.endsWith(`.${ext}`) ? '' : `.${ext}`}`;
  reply.header('Content-Type', a.mime).header('Accept-Ranges', 'bytes').header('Cache-Control', 'private, max-age=3600');
  reply.header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${name}"`);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : st.bytes - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.bytes - 1;
    start = Math.max(0, start);
    end = Math.min(st.bytes - 1, end);
    if (start > end) return reply.status(416).header('Content-Range', `bytes */${st.bytes}`).send();
    reply.status(206).header('Content-Range', `bytes ${start}-${end}/${st.bytes}`).header('Content-Length', end - start + 1);
    return reply.send(storage.createReadStream(a.storageKey, { start, end }));
  }
  reply.header('Content-Length', st.bytes);
  return reply.send(storage.createReadStream(a.storageKey));
}

export async function registerRoutes(app: FastifyInstance) {
  const db = getDb();
  // Provider connections can change in another process (worker) or via the UI: keep the cache fresh.
  app.addHook('onRequest', async () => { await refreshConnections(db); });
  await app.register(registerConnectionRoutes);

  app.get('/health', async () => {
    await db.execute(sql`select 1`);
    const media = await checkMediaTooling();
    return { ok: media.ok, db: 'ok', media };
  });

  // ── Dashboard / settings / providers ───────────────────────────────────────
  app.get('/dashboard', async () => dashboard(db));
  app.get('/settings', async () => getSettings(db));
  app.patch('/settings', async (req) => {
    const patch = body(UpdateSettingsInputSchema, req);
    const cur = await getSettings(db);
    return saveSettings(db, { ...cur, ...(patch.defaultBudgetUsd !== undefined ? { defaultBudgetUsd: patch.defaultBudgetUsd } : {}), mock: { ...cur.mock, ...patch.mock } });
  });
  app.get('/providers', async () => listProviders().map((p) => ({
    id: p.id, displayName: p.displayName, transport: p.transport, implemented: p.implemented, capabilities: p.capabilities,
    requiredEnv: p.requiredEnv, notes: (p as { notes?: string }).notes ?? null,
    ...p.configStatus(), // booleans + missing env NAMES only — never values
    models: p.models, voices: p.voices ?? [],
  })));
  app.get('/voices', async () => listProviders().flatMap((p) => (p.voices ?? []).map((v) => ({ ...v, provider: p.id, providerName: p.displayName }))));
  app.post('/voices/:voiceId/preview', async (req, reply) => {
    const { voiceId } = z.object({ voiceId: z.string().min(1).max(128) }).parse(req.params);
    return reply.status(202).send({ job: await requestVoicePreview(db, voiceId) });
  });
  app.get('/voices/previews', async () => db.select().from(assets).where(eq(assets.kind, 'voice_preview')).orderBy(desc(assets.createdAt)).limit(50));

  // ── Recipes ────────────────────────────────────────────────────────────────
  app.get('/recipes', async () => db.select().from(recipes).orderBy(desc(recipes.builtIn), recipes.name));
  app.get('/recipes/:id', async (req) => {
    const r = await db.query.recipes.findFirst({ where: eq(recipes.id, params(req)) });
    if (!r) throw notFound('Recipe');
    return r;
  });
  app.post('/recipes', async (req, reply) => {
    const input = body(RecipeInputSchema, req);
    const slug = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Date.now().toString(36)}`;
    const [row] = await db.insert(recipes).values({ ...input, slug, builtIn: false }).returning();
    return reply.status(201).send(row);
  });
  app.put('/recipes/:id', async (req) => {
    const input = body(RecipeInputSchema, req);
    const r = await db.query.recipes.findFirst({ where: eq(recipes.id, params(req)) });
    if (!r) throw notFound('Recipe');
    if (r.builtIn) throw new AppError('INVALID_STATE', 'Built-in recipes are read-only. Duplicate it to customise.');
    const [row] = await db.update(recipes).set({ ...input, updatedAt: new Date() }).where(eq(recipes.id, r.id)).returning();
    return row;
  });
  app.post('/recipes/:id/duplicate', async (req, reply) => {
    const r = await db.query.recipes.findFirst({ where: eq(recipes.id, params(req)) });
    if (!r) throw notFound('Recipe');
    const [row] = await db.insert(recipes).values({ slug: `${r.slug}-copy-${Date.now().toString(36)}`, name: `${r.name} (copy)`.slice(0, 80), description: r.description, config: r.config, builtIn: false }).returning();
    return reply.status(201).send(row);
  });
  app.delete('/recipes/:id', async (req, reply) => {
    const r = await db.query.recipes.findFirst({ where: eq(recipes.id, params(req)) });
    if (!r) throw notFound('Recipe');
    if (r.builtIn) throw new AppError('INVALID_STATE', 'Built-in recipes cannot be deleted.');
    await db.delete(recipes).where(eq(recipes.id, r.id)); // projects keep their recipe snapshot
    return reply.status(204).send();
  });

  // ── Projects ───────────────────────────────────────────────────────────────
  app.get('/projects', async () => listProjects(db));
  app.post('/projects', async (req, reply) => reply.status(201).send(await createProject(db, body(CreateProjectInputSchema, req))));
  app.get('/projects/:id', async (req) => getProjectState(db, params(req)));
  app.patch('/projects/:id', async (req) => {
    const id = params(req);
    const patch = body(UpdateProjectInputSchema, req);
    return db.transaction(async (tx) => {
      const [p] = await tx.select().from(projects).where(eq(projects.id, id)).for('update');
      if (!p) throw notFound('Project');
      const [row] = await tx.update(projects).set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.topic !== undefined ? { topic: patch.topic } : {}),
        ...(patch.budgetUsd !== undefined ? { budgetUsd: patch.budgetUsd } : {}),
        ...(patch.voiceId !== undefined ? { voiceId: patch.voiceId } : {}),
        ...(patch.music ? { music: { ...p.music, ...patch.music } } : {}),
        ...(patch.captions ? { captions: { ...p.captions, ...patch.captions } } : {}),
        updatedAt: new Date(),
      }).where(eq(projects.id, id)).returning();
      if (patch.music || patch.captions) await markTimelineStale(tx, id);
      return row;
    });
  });
  app.delete('/projects/:id', async (req, reply) => { await archiveProject(db, params(req)); return reply.status(204).send(); });

  // Pipeline actions → 202 + job (work happens in the worker)
  app.post('/projects/:id/script/generate', async (req, reply) => reply.status(202).send({ job: await startScript(db, params(req), body(Confirm, req).confirmReset) }));
  app.put('/projects/:id/script', async (req) => {
    const b = body(EditScriptInputSchema.extend({ confirmReset: z.boolean().default(false) }), req);
    return { script: await editScript(db, params(req), b, b.confirmReset) };
  });
  app.post('/projects/:id/narration/generate', async (req, reply) => reply.status(202).send({ job: await startNarration(db, params(req), body(Confirm, req).confirmReset) }));
  app.post('/projects/:id/scenes/segment', async (req, reply) => reply.status(202).send({ job: await startSegment(db, params(req), body(Confirm, req).confirmReset) }));
  app.post('/projects/:id/visuals/plan', async (req, reply) => reply.status(202).send({ job: await startPlan(db, params(req)) }));
  app.get('/projects/:id/scenes/estimate', async (req) => estimateAllScenes(db, params(req)));
  app.post('/projects/:id/scenes/generate-all', async (req, reply) => reply.status(202).send(await generateAllScenes(db, params(req))));
  app.post('/projects/:id/music/generate', async (req, reply) => reply.status(202).send({ job: await requestMusic(db, params(req)) }));
  app.post('/projects/:id/captions/generate', async (req) => ({ captions: await generateCaptions(db, params(req)) }));
  app.post('/projects/:id/timeline/assemble', async (req) => ({ timeline: await assembleProjectTimeline(db, params(req)) }));
  app.post('/projects/:id/qa/run', async (req, reply) => reply.status(202).send({ job: await startQa(db, params(req)) }));
  app.post('/projects/:id/render', async (req, reply) => reply.status(202).send({ job: await startRender(db, params(req), body(RenderInputSchema, req).preset) }));
  app.post('/projects/:id/package', async (req, reply) => reply.status(202).send({ job: await requestPackage(db, params(req)) }));

  // ── Scenes ─────────────────────────────────────────────────────────────────
  app.patch('/scenes/:id', async (req) => updateScene(db, params(req), body(UpdateSceneInputSchema, req)));
  app.post('/scenes/:id/generate', async (req, reply) => reply.status(202).send({ jobs: await generateScene(db, params(req), body(GenerateSceneInputSchema, req).alternatives) }));
  app.post('/scenes/:id/duration', async (req) => changeSceneDuration(db, params(req), body(SceneDurationInputSchema, req).durationSec));
  app.post('/scenes/:id/select-asset', async (req) => ({ assetId: await selectSceneAsset(db, params(req), body(SelectAssetInputSchema, req).assetId) }));

  // ── Assets ─────────────────────────────────────────────────────────────────
  app.get('/assets', async (req) => {
    const q = z.object({ mediaType: z.enum(['image', 'video', 'audio', 'archive']).optional(), projectId: z.string().uuid().optional(), scope: z.enum(['all', 'library']).default('all') }).parse(req.query);
    const where = [];
    if (q.mediaType) where.push(eq(assets.mediaType, q.mediaType));
    if (q.projectId) where.push(or(eq(assets.projectId, q.projectId), isNull(assets.projectId)));
    if (q.scope === 'library') where.push(isNull(assets.projectId));
    const rows = await db.select({ asset: assets, projectTitle: projects.title }).from(assets).leftJoin(projects, eq(projects.id, assets.projectId))
      .where(where.length ? and(...where) : undefined).orderBy(desc(assets.createdAt)).limit(300);
    return rows.map((r) => ({ ...r.asset, projectTitle: r.projectTitle }));
  });
  app.get('/assets/:id/file', async (req, reply) => sendAsset(req, reply, false));
  app.get('/assets/:id/download', async (req, reply) => sendAsset(req, reply, true));
  app.get('/assets/:id/thumbnail', async (req, reply) => {
    const a = await db.query.assets.findFirst({ where: eq(assets.id, params(req)) });
    if (!a) throw notFound('Asset');
    let key = a.mediaType === 'image' ? a.storageKey : typeof a.metadata.thumbnailKey === 'string' ? a.metadata.thumbnailKey : null;
    if (a.mediaType === 'video' && (!key || !(await getStorage().stat(key)))) {
      // Generate on demand (e.g. assets created before thumbnails existed).
      key = await createVideoThumbnail(a.storageKey, a.durationSec);
      await db.update(assets).set({ metadata: { ...a.metadata, thumbnailKey: key } }).where(eq(assets.id, a.id));
    }
    if (!key || !(await getStorage().stat(key))) throw new AppError('NOT_FOUND', 'No thumbnail for this asset');
    reply.header('Content-Type', a.mediaType === 'image' ? a.mime : 'image/jpeg').header('Cache-Control', 'private, max-age=86400');
    return reply.send(getStorage().createReadStream(key));
  });
  app.post('/assets/upload', async (req, reply) => {
    const q = z.object({ projectId: z.string().uuid().optional(), sceneId: z.string().uuid().optional() }).parse(req.query);
    const file = await req.file();
    if (!file) throw new AppError('VALIDATION_ERROR', 'No file uploaded');
    const ext = path.extname(file.filename).slice(1).toLowerCase();
    const type = UPLOAD_TYPES[ext];
    if (!type) throw new AppError('UPLOAD_REJECTED', `Unsupported file type ".${ext}". Allowed: ${Object.keys(UPLOAD_TYPES).join(', ')}`);
    const dir = await getStorage().tmpDir('upload');
    try {
      const tmp = path.join(dir, `upload.${ext}`);
      await pipeline(file.file, createWriteStream(tmp));
      if (file.file.truncated) throw new AppError('UPLOAD_REJECTED', 'File exceeds the upload size limit');
      // Untrusted input: must actually decode as the claimed media type.
      let p;
      try { p = await probe(tmp); } catch { throw new AppError('UPLOAD_REJECTED', 'File could not be decoded as media'); }
      // Container must match the extension (ffprobe will happily "decode" text files as tty video).
      if (!type.formats.includes(p.formatName)) throw new AppError('UPLOAD_REJECTED', `File content (${p.formatName || 'unknown'}) does not match .${ext}`);
      const ok = type.mediaType === 'audio' ? p.hasAudio && !p.hasVideo : type.mediaType === 'video' ? p.hasVideo && (p.durationSec ?? 0) > 0.1 : p.hasVideo;
      if (!ok) throw new AppError('UPLOAD_REJECTED', `File content does not match a valid ${type.mediaType}`);
      if (q.projectId && !(await db.query.projects.findFirst({ where: eq(projects.id, q.projectId), columns: { id: true } }))) throw notFound('Project');
      const label = path.basename(file.filename).replace(/[^\w.\- ]+/g, '').slice(0, 120) || `upload.${ext}`;
      const asset = await ingestFile(db, { projectId: q.projectId ?? null, kind: 'upload', mediaType: type.mediaType, source: 'uploaded', label, srcPath: tmp, ext, mime: type.mime, move: true });
      if (q.sceneId) await selectSceneAsset(db, q.sceneId, asset.id);
      return reply.status(201).send(asset);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // ── Jobs / costs ───────────────────────────────────────────────────────────
  app.get('/jobs', async (req) => listJobs(db, z.object({ status: z.string().max(20).optional(), projectId: z.string().uuid().optional() }).parse(req.query)));
  app.post('/jobs/:id/cancel', async (req) => cancelJob(db, params(req)));
  app.post('/jobs/:id/retry', async (req, reply) => reply.status(202).send({ job: await retryJob(db, params(req)) }));
  app.get('/costs', async () => costsOverview(db));

}
