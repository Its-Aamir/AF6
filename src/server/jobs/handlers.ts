/**
 * Job handlers. Each is resumable/idempotent: it re-reads persisted state on
 * every run and checks the project is still in the expected state before
 * committing, so retries, reclaims after crashes and reschedules are safe.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  ScriptAnalysisSchema, ScriptSchema, VisualPlanSchema, type ProjectStatus, type Script, type SceneStatus, type VisualStrategy,
} from '../../shared/schemas';
import { nextProjectStatus, nextSceneStatus, type ProjectStep } from '../../shared/stateMachines';
import type { Db } from '../db/client';
import { assets, costEntries, generations, projects, scenes } from '../db/schema';
import { AppError } from '../errors';
import { asDataBlock, runStructured, sanitizeText } from '../llm/structured';
import { getLlm } from '../llm/mockLlm';
import { writeZip, type PackageEntry } from '../media/package';
import { renderTimeline } from '../media/render';
import { analyzeRender } from '../media/analyze';
import { buildRenderReport, simulatedContent } from '../services/publish';
import { toSrt } from '../services/captions';
import { projectCostSummary, recordCost } from '../services/costs';
import { driveGeneration, markGenerationFailed, markGenerationSucceeded, POLL_INTERVAL_MS } from '../services/generation';
import { ingestFile, materializeOutput, mediaTypeForCapability } from '../services/assets';
import { lockProject, markTimelineStale, resetDownstream, setStatus, settleProjectAssets } from '../services/pipeline';
import { runQaChecks } from '../services/qa';
import { capabilityFor, settleScene } from '../services/scenes';
import { reconcileTimings, segmentNarration } from '../services/segmentation';
import { detectSilences, pauseAlign, tokenizeScript, transcriptAlign } from '../services/alignment';
import { getProvider } from '../providers/registry';
import type { ElevenLabsProvider } from '../providers/real/elevenlabs';
import { isLoopback } from '../providers/real/http';
import { config } from '../config';
import type { WordTiming } from '../../shared/schemas';
import { MAX_SCRIPT_CHARS } from '../../shared/schemas';
import { getStorage } from '../storage/storage';
import { done, reschedule, type JobHandler } from './types';

const ProjectPayload = z.object({ projectId: z.string().uuid() });
const GenPayload = z.object({ projectId: z.string().uuid(), generationId: z.string().uuid() });

const STEP_LABEL: Record<ProjectStep, string> = {
  script: 'Script generation', narration: 'Narration', segment: 'Scene segmentation', plan: 'Visual planning',
  assets: 'Asset generation', assemble: 'Timeline assembly', qa: 'QA', render: 'Render',
};

async function loadProject(db: Db, projectId: string) {
  const p = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!p) throw new AppError('NOT_FOUND', 'Project no longer exists', { retryable: false });
  return p;
}

/** Revert a busy step via the state machine and record the error on the project. */
async function failStep(db: Db, projectId: string, step: ProjectStep, error: AppError) {
  await db.transaction(async (tx) => {
    const [p] = await tx.select().from(projects).where(eq(projects.id, projectId)).for('update');
    if (!p) return;
    const next = nextProjectStatus(p.status as ProjectStatus, { type: 'FAILED', step, revertTo: (p.resumeStatus ?? 'draft') as ProjectStatus });
    await setStatus(tx, projectId, next, { lastError: `${STEP_LABEL[step]} failed: ${error.message}`.slice(0, 2000) });
  });
}

async function recordLlmCost(db: Db, projectId: string, inputTokens: number, outputTokens: number, costUsd?: number) {
  const llm = getLlm();
  const units = (inputTokens + outputTokens) / 1000;
  const amountUsd = costUsd ?? Math.round(units * llm.unitCostPer1kTokensUsd * 10000) / 10000;
  await recordCost(db, {
    projectId, kind: 'actual', capability: 'llm', provider: llm.id, model: llm.model,
    estimate: { units, unit: '1k_tokens', unitCostUsd: units ? Math.round((amountUsd / units) * 1e6) / 1e6 : 0, amountUsd, simulated: llm.simulated },
  });
}

// ── script.generate ──────────────────────────────────────────────────────────

const SYSTEM_SCRIPT = 'You are a documentary scriptwriter. Respond with a single JSON object only, matching the requested schema exactly. No prose, no markdown.';

export const scriptGenerate: JobHandler<z.infer<typeof ProjectPayload>> = {
  type: 'script.generate',
  payloadSchema: ProjectPayload,
  async run({ db, payload, signal, progress }) {
    const p = await loadProject(db, payload.projectId);
    if (p.status !== 'scripting') return done({ skipped: `project is ${p.status}` });
    const r = p.recipeSnapshot;
    let script: Script;
    await progress(0.1, p.inputMode === 'topic' ? 'Writing script' : 'Analysing script');
    if (p.inputMode === 'topic') {
      const topic = sanitizeText(p.topic, 1000);
      const res = await runStructured(getLlm(), {
        task: 'script.generate', signal, system: SYSTEM_SCRIPT,
        prompt: [
          `Write a narration script for a ${r.targetDurationSec}s video at ~${r.wordsPerMinute} words per minute.`,
          `Tone: ${r.tone}. Audience: ${r.audience}. Sections (in order): ${r.structure.join(' | ')}.`,
          'JSON shape: {"title": string, "summary": string, "hook": string, "sections": [{"heading": string, "narration": string}]}',
          asDataBlock('topic', topic),
        ].join('\n'),
        context: { topic, recipe: { structure: r.structure, targetDurationSec: r.targetDurationSec, wordsPerMinute: r.wordsPerMinute, tone: r.tone } },
      }, ScriptSchema, (v) => {
        const words = v.sections.map((s) => s.narration).join(' ').split(/\s+/).length;
        return words < 10 ? ['Script is too short (fewer than 10 words).'] : [];
      });
      script = res.value;
      await recordLlmCost(db, p.id, res.inputTokens, res.outputTokens, res.costUsd);
    } else {
      // User script: narration is kept VERBATIM; the model only labels it.
      const clean = sanitizeText(p.sourceScript, MAX_SCRIPT_CHARS);
      let paragraphs = clean.split(/\n\s*\n/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (paragraphs.length > 40) paragraphs = [...paragraphs.slice(0, 39), paragraphs.slice(39).join(' ')];
      const res = await runStructured(getLlm(), {
        task: 'script.analyze', signal, system: SYSTEM_SCRIPT,
        prompt: [
          `Give a title, a one-sentence summary and one short heading per paragraph (${paragraphs.length} paragraphs).`,
          'JSON shape: {"title": string, "summary": string, "sectionHeadings": string[]}',
          asDataBlock('script', paragraphs.map((x, i) => `[${i + 1}] ${x}`).join('\n\n')),
        ].join('\n'),
        context: { paragraphs },
      }, ScriptAnalysisSchema, (v) => (v.sectionHeadings.length === paragraphs.length ? [] : [`Expected exactly ${paragraphs.length} headings, got ${v.sectionHeadings.length}.`]));
      await recordLlmCost(db, p.id, res.inputTokens, res.outputTokens, res.costUsd);
      script = {
        title: res.value.title, summary: res.value.summary, hook: paragraphs[0].split(/(?<=[.!?])\s/)[0].slice(0, 600),
        sections: paragraphs.map((narration, i) => ({ heading: res.value.sectionHeadings[i], narration: narration.slice(0, 8000) })),
      };
    }
    signal.throwIfAborted();
    await db.transaction(async (tx) => {
      const locked = await lockProject(tx, p.id);
      if (locked.status !== 'scripting') return;
      await resetDownstream(tx, p.id, 'script');
      await setStatus(tx, p.id, nextProjectStatus('scripting', { type: 'DONE', step: 'script' }), { script, resumeStatus: null });
    });
    return done({ sections: script.sections.length });
  },
  async onFailed({ db, payload, error }) { await failStep(db, payload.projectId, 'script', error); },
};

// ── narration.generate ───────────────────────────────────────────────────────

export const narrationGenerate: JobHandler<z.infer<typeof GenPayload>> = {
  type: 'narration.generate',
  payloadSchema: GenPayload,
  async run(ctx) {
    const { db, payload, signal } = ctx;
    const r = await driveGeneration(ctx, payload.generationId);
    if (r.state === 'waiting') return reschedule(POLL_INTERVAL_MS);
    if (r.state === 'already_done') return done({ alreadyDone: true });
    const file = await materializeOutput(r.output, signal);
    try {
      await ctx.progress(0.96, 'Measuring narration');
      const asset = await ingestFile(db, {
        projectId: payload.projectId, generationId: r.gen.id, kind: 'narration', mediaType: 'audio', source: 'generated',
        label: 'Narration', srcPath: file.path, ext: r.output.ext, mime: r.output.mime, metadata: { provider: r.gen.provider, model: r.gen.model },
      });
      const measured = asset.durationSec;
      if (!measured || measured <= 0) throw new AppError('MEDIA_ERROR', 'Narration audio has no measurable duration', { retryable: true });
      const providerWords = r.output.words ?? [];
      if (!providerWords.length) throw new AppError('PROVIDER_ERROR', 'TTS provider returned no word timings', { retryable: false });
      const lastEnd = providerWords[providerWords.length - 1].end;
      const words = lastEnd > measured ? reconcileTimings(providerWords, lastEnd + 0.1, measured) : providerWords;
      signal.throwIfAborted();
      await db.transaction(async (tx) => {
        await markGenerationSucceeded(tx, r.gen, asset.id, r.actualCost);
        const p = await lockProject(tx, payload.projectId);
        if (p.status !== 'narrating') return;
        await resetDownstream(tx, p.id, 'narration');
        await setStatus(tx, p.id, nextProjectStatus('narrating', { type: 'DONE', step: 'narration' }), {
          narrationAssetId: asset.id, narrationDurationSec: measured, narrationWords: words, resumeStatus: null,
          narrationTimingSource: r.gen.provider === 'mock' ? 'simulated' : 'tts_timestamps',
        });
      });
      return done({ durationSec: measured, words: words.length });
    } finally {
      await file.cleanup();
    }
  },
  async onFailed({ db, payload, error }) {
    await markGenerationFailed(db, payload.generationId, error);
    await failStep(db, payload.projectId, 'narration', error);
  },
};

// ── narration.align (user-supplied voiceover) ───────────────────────────────

export const narrationAlign: JobHandler<z.infer<typeof ProjectPayload>> = {
  type: 'narration.align',
  payloadSchema: ProjectPayload,
  async run({ db, payload, signal, progress, log }) {
    const p = await loadProject(db, payload.projectId);
    if (p.status !== 'narrating') return done({ skipped: `project is ${p.status}` });
    if (!p.voiceoverAssetId || !p.script) throw new AppError('INVALID_STATE', 'Voiceover or script missing', { retryable: false });
    const asset = await db.query.assets.findFirst({ where: eq(assets.id, p.voiceoverAssetId) });
    if (!asset?.durationSec) throw new AppError('INVALID_STATE', 'Uploaded voiceover not found', { retryable: false });
    const audioPath = getStorage().resolve(asset.storageKey);
    const scriptWords = tokenizeScript(p.script.sections.map((s) => s.narration).join(' '));
    let words: WordTiming[] | null = null;
    let source = 'pause_alignment';
    let note = '';
    const el = getProvider('elevenlabs') as ElevenLabsProvider;
    if (el.canTranscribe() && (!config.isTest || isLoopback(el.baseUrl))) {
      await progress(0.2, 'Transcribing voiceover (ElevenLabs)');
      try {
        const t = await el.transcribe(audioPath, signal);
        const aligned = transcriptAlign(scriptWords, t.words, asset.durationSec);
        if (aligned.matchRatio >= 0.6) { words = aligned.words; source = 'transcription'; }
        else note = `Voiceover matches only ${Math.round(aligned.matchRatio * 100)}% of the script words — check that the right script/voiceover pair was used. Using pause-based alignment.`;
      } catch (e) {
        note = `Transcription failed (${(e as Error).message}); using pause-based alignment.`;
        log(note);
      }
    }
    if (!words) {
      await progress(0.5, 'Aligning script to voiceover pauses');
      words = pauseAlign(scriptWords, await detectSilences(audioPath), asset.durationSec);
    }
    signal.throwIfAborted();
    await db.transaction(async (tx) => {
      const locked = await lockProject(tx, p.id);
      if (locked.status !== 'narrating') return;
      await resetDownstream(tx, p.id, 'narration');
      await setStatus(tx, p.id, nextProjectStatus('narrating', { type: 'DONE', step: 'narration' }), {
        narrationAssetId: asset.id, narrationDurationSec: asset.durationSec, narrationWords: words, narrationTimingSource: source,
        resumeStatus: null, lastError: note || null,
      });
    });
    return done({ durationSec: asset.durationSec, words: words.length, source });
  },
  async onFailed({ db, payload, error }) { await failStep(db, payload.projectId, 'narration', error); },
};

// ── scenes.segment ───────────────────────────────────────────────────────────

export const scenesSegment: JobHandler<z.infer<typeof ProjectPayload>> = {
  type: 'scenes.segment',
  payloadSchema: ProjectPayload,
  async run({ db, payload }) {
    const p = await loadProject(db, payload.projectId);
    if (p.status !== 'segmenting') return done({ skipped: `project is ${p.status}` });
    if (!p.narrationWords?.length || !p.narrationDurationSec) throw new AppError('INVALID_STATE', 'Narration timing missing', { retryable: false });
    const r = p.recipeSnapshot;
    const segs = segmentNarration(p.narrationWords, p.narrationDurationSec, r.minSceneSec, r.maxSceneSec);
    await db.transaction(async (tx) => {
      const locked = await lockProject(tx, p.id);
      if (locked.status !== 'segmenting') return;
      await resetDownstream(tx, p.id, 'segment');
      await tx.insert(scenes).values(segs.map((s, i) => ({
        projectId: p.id, index: i + 1, startSec: s.start, endSec: s.end, wordStart: s.wordStart, wordEnd: s.wordEnd, narration: s.text, status: 'pending',
      })));
      await setStatus(tx, p.id, nextProjectStatus('segmenting', { type: 'DONE', step: 'segment' }), { resumeStatus: null });
    });
    return done({ scenes: segs.length });
  },
  async onFailed({ db, payload, error }) { await failStep(db, payload.projectId, 'segment', error); },
};

// ── visuals.plan ─────────────────────────────────────────────────────────────

export const visualsPlan: JobHandler<z.infer<typeof ProjectPayload>> = {
  type: 'visuals.plan',
  payloadSchema: ProjectPayload,
  async run({ db, payload, signal, progress }) {
    const p = await loadProject(db, payload.projectId);
    if (p.status !== 'planning') return done({ skipped: `project is ${p.status}` });
    const rows = await db.select().from(scenes).where(eq(scenes.projectId, p.id)).orderBy(scenes.index);
    if (!rows.length) throw new AppError('INVALID_STATE', 'No scenes to plan', { retryable: false });
    const r = p.recipeSnapshot;
    await progress(0.2, `Planning ${rows.length} scenes`);
    const n = rows.length;
    const res = await runStructured(getLlm(), {
      task: 'visuals.plan', signal,
      system: 'You are a film director planning visuals for a narrated video. Respond with one JSON object only.',
      prompt: [
        `Plan one visual per scene (${n} scenes). Visual style: ${r.visualStyle}. Tone: ${r.tone}.`,
        `Roughly ${Math.round(r.videoRatio * 100)}% of scenes should use "ai_video", the rest "ai_image".`,
        'JSON shape: {"styleNotes": string, "scenes": [{"sceneIndex": int, "strategy": "ai_video"|"ai_image", "prompt": string, "negativePrompt": string, "camera": string, "shotType": string, "mood": string, "onScreenText": string|null}]}',
        asDataBlock('scenes', rows.map((s) => `[${s.index}] (${(s.endSec - s.startSec).toFixed(1)}s) ${s.narration}`).join('\n')),
      ].join('\n'),
      context: { scenes: rows.map((s) => ({ index: s.index, narration: s.narration })), recipe: { visualStyle: r.visualStyle, negativePrompt: r.negativePrompt, videoRatio: r.videoRatio, tone: r.tone }, topic: p.topic },
    }, VisualPlanSchema, (v) => {
      const idx = v.scenes.map((s) => s.sceneIndex).sort((a, b) => a - b);
      const ok = idx.length === n && idx.every((x, i) => x === i + 1);
      return ok ? [] : [`scenes must contain exactly one entry for each sceneIndex 1..${n}`];
    });
    await recordLlmCost(db, p.id, res.inputTokens, res.outputTokens, res.costUsd);
    signal.throwIfAborted();
    await db.transaction(async (tx) => {
      const locked = await lockProject(tx, p.id);
      if (locked.status !== 'planning') return;
      const current = await tx.select().from(scenes).where(eq(scenes.projectId, p.id)).for('update');
      for (const s of current) {
        if (s.locked || s.status === 'queued' || s.status === 'generating') continue;
        const brief = res.value.scenes.find((b) => b.sceneIndex === s.index)!;
        const cap = capabilityFor(brief.strategy);
        const def = r.defaults[cap];
        await tx.update(scenes).set({
          brief, prompt: brief.prompt, negativePrompt: brief.negativePrompt, visualStrategy: brief.strategy as VisualStrategy,
          provider: def.provider, model: def.model, qualityStatus: 'unchecked',
          status: nextSceneStatus({ status: s.status as SceneStatus, locked: false, hasAsset: !!s.selectedAssetId }, { type: 'PLAN' }),
          updatedAt: new Date(),
        }).where(eq(scenes.id, s.id));
      }
      await setStatus(tx, p.id, nextProjectStatus('planning', { type: 'DONE', step: 'plan' }), { visualStyleNotes: res.value.styleNotes, resumeStatus: null, timeline: null });
      await settleProjectAssets(tx, p.id);
    });
    return done({ planned: n, repaired: res.repaired });
  },
  async onFailed({ db, payload, error }) { await failStep(db, payload.projectId, 'plan', error); },
};

// ── scene.generate ───────────────────────────────────────────────────────────

const SceneGenPayload = z.object({ generationId: z.string().uuid(), autoSelect: z.boolean().default(true) });

export const sceneGenerate: JobHandler<z.infer<typeof SceneGenPayload>> = {
  type: 'scene.generate',
  payloadSchema: SceneGenPayload,
  async run(ctx) {
    const { db, payload, signal } = ctx;
    const gen0 = await db.query.generations.findFirst({ where: eq(generations.id, payload.generationId) });
    if (!gen0) throw new AppError('NOT_FOUND', 'Generation missing', { retryable: false });
    if (!gen0.sceneId) throw new AppError('CANCELLED', 'Scene was removed (script/narration changed)');
    const r = await driveGeneration(ctx, payload.generationId);
    if (r.state === 'waiting') {
      await settleScene(db, gen0.sceneId);
      return reschedule(POLL_INTERVAL_MS);
    }
    if (r.state === 'already_done') return done({ alreadyDone: true });
    const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, gen0.sceneId) });
    const file = await materializeOutput(r.output, signal);
    try {
      const mediaType = mediaTypeForCapability(r.gen.capability);
      const asset = await ingestFile(db, {
        projectId: r.gen.projectId, sceneId: gen0.sceneId, generationId: r.gen.id, kind: mediaType === 'video' ? 'video' : 'image', mediaType, source: 'generated',
        label: `Scene ${scene?.index ?? '?'} · ${r.gen.model}`, srcPath: file.path, ext: r.output.ext, mime: r.output.mime,
        metadata: { provider: r.gen.provider, model: r.gen.model, prompt: r.gen.prompt },
      });
      signal.throwIfAborted();
      await db.transaction(async (tx) => {
        await markGenerationSucceeded(tx, r.gen, asset.id, r.actualCost);
        await lockProject(tx, r.gen.projectId!);
        const [s] = await tx.select().from(scenes).where(eq(scenes.id, gen0.sceneId!)).for('update');
        if (!s) return;
        if (!s.locked && (payload.autoSelect || !s.selectedAssetId)) {
          await tx.update(scenes).set({ selectedAssetId: asset.id, qualityStatus: 'unchecked', error: null, updatedAt: new Date() }).where(eq(scenes.id, s.id));
        }
        await settleScene(tx, s.id, null);
        await settleProjectAssets(tx, r.gen.projectId!);
        await markTimelineStale(tx, r.gen.projectId!);
      });
      return done({ assetId: asset.id });
    } finally {
      await file.cleanup();
    }
  },
  async onFailed({ db, payload, error }) {
    const gen = await markGenerationFailed(db, payload.generationId, error);
    if (!gen?.sceneId || !gen.projectId) return;
    await db.transaction(async (tx) => {
      await settleScene(tx, gen.sceneId!, error.message.slice(0, 1000));
      await settleProjectAssets(tx, gen.projectId!);
    });
  },
};

// ── music.generate ───────────────────────────────────────────────────────────

export const musicGenerate: JobHandler<z.infer<typeof GenPayload>> = {
  type: 'music.generate',
  payloadSchema: GenPayload,
  async run(ctx) {
    const { db, payload, signal } = ctx;
    const r = await driveGeneration(ctx, payload.generationId);
    if (r.state === 'waiting') return reschedule(POLL_INTERVAL_MS);
    if (r.state === 'already_done') return done({ alreadyDone: true });
    const file = await materializeOutput(r.output, signal);
    try {
      const asset = await ingestFile(db, {
        projectId: payload.projectId, generationId: r.gen.id, kind: 'music', mediaType: 'audio', source: 'generated',
        label: `Music · ${r.gen.prompt}`.slice(0, 120), srcPath: file.path, ext: r.output.ext, mime: r.output.mime,
      });
      await db.transaction(async (tx) => {
        await markGenerationSucceeded(tx, r.gen, asset.id, r.actualCost);
        await lockProject(tx, payload.projectId);
        await tx.update(projects).set({ musicAssetId: asset.id, updatedAt: new Date() }).where(eq(projects.id, payload.projectId));
        await markTimelineStale(tx, payload.projectId);
      });
      return done({ assetId: asset.id });
    } finally {
      await file.cleanup();
    }
  },
  async onFailed({ db, payload, error }) {
    await markGenerationFailed(db, payload.generationId, error);
    await db.update(projects).set({ lastError: `Music generation failed: ${error.message}`.slice(0, 2000), updatedAt: new Date() }).where(eq(projects.id, payload.projectId));
  },
};

// ── qa.run ───────────────────────────────────────────────────────────────────

export const qaRun: JobHandler<z.infer<typeof ProjectPayload>> = {
  type: 'qa.run',
  payloadSchema: ProjectPayload,
  async run({ db, payload, progress }) {
    const p = await loadProject(db, payload.projectId);
    if (p.status !== 'qa_running') return done({ skipped: `project is ${p.status}` });
    const sceneRows = await db.select().from(scenes).where(eq(scenes.projectId, p.id)).orderBy(scenes.index);
    const ids = [...sceneRows.map((s) => s.selectedAssetId), p.narrationAssetId, p.musicAssetId].filter((x): x is string => !!x);
    const assetRows = ids.length ? await db.select().from(assets).where(inArray(assets.id, ids)) : [];
    const storage = getStorage();
    const existingKeys = new Set<string>();
    for (const a of assetRows) if (await storage.stat(a.storageKey)) existingKeys.add(a.storageKey);
    const gens = await db.select().from(generations).where(eq(generations.projectId, p.id));
    await progress(0.5, 'Running checks');
    const { report, sceneQuality } = runQaChecks({
      project: p, scenes: sceneRows, assetsById: new Map(assetRows.map((a) => [a.id, a])), generations: gens, existingKeys,
      cost: await projectCostSummary(db, p.id, p.budgetUsd),
    });
    await db.transaction(async (tx) => {
      const locked = await lockProject(tx, p.id);
      if (locked.status !== 'qa_running') return;
      for (const [sceneId, q] of sceneQuality) {
        await tx.update(scenes).set({ qualityStatus: q.status, qualityNotes: q.notes || null }).where(eq(scenes.id, sceneId));
      }
      await setStatus(tx, p.id, nextProjectStatus('qa_running', { type: 'DONE', step: 'qa', passed: report.passed }), { qaReport: report, resumeStatus: null });
    });
    return done({ passed: report.passed, checks: report.checks.length });
  },
  async onFailed({ db, payload, error }) { await failStep(db, payload.projectId, 'qa', error); },
};

// ── render.final ─────────────────────────────────────────────────────────────

const RenderPayload = z.object({ projectId: z.string().uuid(), preset: z.enum(['draft', 'final', 'hd']).default('final') });

export const renderFinal: JobHandler<z.infer<typeof RenderPayload>> = {
  type: 'render.final',
  payloadSchema: RenderPayload,
  async run({ db, payload, signal, progress }) {
    const p = await loadProject(db, payload.projectId);
    if (p.status !== 'rendering') return done({ skipped: `project is ${p.status}` });
    if (!p.timeline) throw new AppError('INVALID_STATE', 'No timeline', { retryable: false });
    const t = p.timeline;
    const ids = [...t.video.map((c) => c.assetId), t.narration.assetId, ...(t.music ? [t.music.assetId] : [])];
    const rows = await db.select().from(assets).where(inArray(assets.id, ids));
    const byId = new Map(rows.map((a) => [a.id, a]));
    const storage = getStorage();
    const workDir = await storage.tmpDir(`render-${p.id.slice(0, 8)}`);
    try {
      const outPath = path.join(workDir, 'final.mp4');
      const result = await renderTimeline(t, {
        preset: payload.preset, workDir, outPath, signal,
        resolveAssetPath: (id) => {
          const a = byId.get(id);
          if (!a) throw new AppError('MEDIA_ERROR', `Timeline references missing asset ${id}`, { retryable: false });
          return storage.resolve(a.storageKey);
        },
        onProgress: (f, m) => progress(f * 0.97, m),
      });
      const asset = await ingestFile(db, {
        projectId: p.id, kind: 'render', mediaType: 'video', source: 'rendered', label: `Final render (${payload.preset}) · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        srcPath: outPath, ext: 'mp4', mime: 'video/mp4', move: true, metadata: { preset: payload.preset, ...result },
      });
      signal.throwIfAborted();
      await progress(0.98, 'Checking loudness, black frames and silence');
      const analysis = await analyzeRender(storage.resolve(asset.storageKey));
      const report = buildRenderReport({ assetId: asset.id, durationSec: result.durationSec, width: result.width, height: result.height, preset: payload.preset, analysis, simulated: await simulatedContent(db, p) });
      await db.transaction(async (tx) => {
        const locked = await lockProject(tx, p.id);
        if (locked.status !== 'rendering') return;
        await setStatus(tx, p.id, nextProjectStatus('rendering', { type: 'DONE', step: 'render' }), { finalRenderAssetId: asset.id, renderReport: report, resumeStatus: null });
      });
      return done({ assetId: asset.id, ...result });
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  },
  async onFailed({ db, payload, error }) { await failStep(db, payload.projectId, 'render', error); },
};

// ── package.export ───────────────────────────────────────────────────────────

export const packageExport: JobHandler<z.infer<typeof ProjectPayload>> = {
  type: 'package.export',
  payloadSchema: ProjectPayload,
  async run({ db, payload, signal, progress }) {
    const p = await loadProject(db, payload.projectId);
    const storage = getStorage();
    const sceneRows = await db.select().from(scenes).where(eq(scenes.projectId, p.id)).orderBy(scenes.index);
    const ids = [...sceneRows.map((s) => s.selectedAssetId), p.narrationAssetId, p.musicAssetId, p.finalRenderAssetId].filter((x): x is string => !!x);
    const rows = ids.length ? await db.select().from(assets).where(inArray(assets.id, ids)) : [];
    const byId = new Map(rows.map((a) => [a.id, a]));
    const costs = await db.select().from(costEntries).where(and(eq(costEntries.projectId, p.id), eq(costEntries.kind, 'actual')));
    const entries: PackageEntry[] = [];
    const addAsset = async (id: string | null, name: string) => {
      const a = id ? byId.get(id) : undefined;
      if (a && (await storage.stat(a.storageKey))) entries.push({ name: `${name}.${a.storageKey.split('.').pop()}`, path: storage.resolve(a.storageKey) });
    };
    await addAsset(p.finalRenderAssetId, 'final');
    await addAsset(p.narrationAssetId, 'audio/narration');
    await addAsset(p.musicAssetId, 'audio/music');
    for (const s of sceneRows) await addAsset(s.selectedAssetId, `scenes/scene-${String(s.index).padStart(2, '0')}`);
    if (p.script) {
      entries.push({ name: 'script.md', content: `# ${p.script.title}\n\n${p.script.summary}\n\n${p.script.sections.map((s) => `## ${s.heading}\n\n${s.narration}`).join('\n\n')}\n` });
    }
    if (p.captions.cues.length) entries.push({ name: 'captions.srt', content: toSrt(p.captions.cues) });
    const manifest = {
      format: 'af6-studio-package', version: 1, exportedAt: new Date().toISOString(),
      project: {
        id: p.id, title: p.title, status: p.status, inputMode: p.inputMode, topic: p.topic, recipe: p.recipeName, recipeConfig: p.recipeSnapshot,
        narrationDurationSec: p.narrationDurationSec, voiceId: p.voiceId, music: p.music, captions: { ...p.captions, cues: p.captions.cues.length },
      },
      script: p.script, timeline: p.timeline, qaReport: p.qaReport,
      scenes: sceneRows.map((s) => ({ index: s.index, start: s.startSec, end: s.endSec, narration: s.narration, strategy: s.visualStrategy, provider: s.provider, model: s.model, prompt: s.prompt, locked: s.locked, quality: s.qualityStatus })),
      costs: { totalUsd: Math.round(costs.reduce((a, c) => a + c.amountUsd, 0) * 10000) / 10000, simulated: costs.every((c) => c.simulated) },
    };
    entries.push({ name: 'project.json', content: JSON.stringify(manifest, null, 2) });
    await progress(0.3, `Packaging ${entries.length} files`);
    const dir = await storage.tmpDir('package');
    try {
      const zipPath = path.join(dir, 'package.zip');
      await writeZip(zipPath, entries, signal);
      const safeTitle = p.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'project';
      const asset = await ingestFile(db, {
        projectId: p.id, kind: 'package', mediaType: 'archive', source: 'rendered', label: `${safeTitle}-package.zip`,
        srcPath: zipPath, ext: 'zip', mime: 'application/zip', move: true, metadata: { files: entries.map((e) => e.name) },
      });
      await db.update(projects).set({ packageAssetId: asset.id, updatedAt: new Date() }).where(eq(projects.id, p.id));
      return done({ assetId: asset.id, files: entries.length });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
  async onFailed({ db, payload, error }) {
    await db.update(projects).set({ lastError: `Package export failed: ${error.message}`.slice(0, 2000), updatedAt: new Date() }).where(eq(projects.id, payload.projectId));
  },
};

// ── voice.preview ────────────────────────────────────────────────────────────

const VoicePayload = z.object({ voiceId: z.string(), generationId: z.string().uuid() });

export const voicePreview: JobHandler<z.infer<typeof VoicePayload>> = {
  type: 'voice.preview',
  payloadSchema: VoicePayload,
  async run(ctx) {
    const { db, payload, signal } = ctx;
    const r = await driveGeneration(ctx, payload.generationId);
    if (r.state === 'waiting') return reschedule(POLL_INTERVAL_MS);
    if (r.state === 'already_done') return done({ alreadyDone: true });
    const file = await materializeOutput(r.output, signal);
    try {
      const asset = await ingestFile(db, {
        projectId: null, generationId: r.gen.id, kind: 'voice_preview', mediaType: 'audio', source: 'generated',
        label: `Voice preview · ${payload.voiceId}`, srcPath: file.path, ext: r.output.ext, mime: r.output.mime, metadata: { voiceId: payload.voiceId },
      });
      await db.transaction(async (tx) => { await markGenerationSucceeded(tx, r.gen, asset.id, r.actualCost); });
      return done({ assetId: asset.id });
    } finally {
      await file.cleanup();
    }
  },
  async onFailed({ db, payload, error }) { await markGenerationFailed(db, payload.generationId, error); },
};

export const ALL_HANDLERS: JobHandler<never>[] = [
  scriptGenerate, narrationGenerate, narrationAlign, scenesSegment, visualsPlan, sceneGenerate, musicGenerate, qaRun, renderFinal, packageExport, voicePreview,
] as unknown as JobHandler<never>[];
