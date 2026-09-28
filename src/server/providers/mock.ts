/**
 * Mock generation provider. Behaves like a real async generation API:
 *   submit → task id → poll (queued/running + progress) → success | failure | never-finishes (timeout)
 * Task state lives in `mock_provider_tasks`, so polling survives worker restarts.
 * Outputs are real media files so the whole pipeline (QA, render) is exercised.
 *
 * Deterministic test hooks: include `[mock:fail]` or `[mock:timeout]` in a prompt.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { mockProviderTasks } from '../db/schema';
import { AppError } from '../errors';
import { runFfmpeg } from '../media/ffmpeg';
import { encodeWav, hashString, planSpeech, synthesizeMusic, synthesizeSpeech } from '../media/wav';
import { getSettings } from '../services/settings';
import { getStorage } from '../storage/storage';
import type { CostEstimate, GenerationProvider, GenerationRequest, ModelInfo, PollResult, VoiceInfo } from './types';

export const MOCK_MODELS: ModelInfo[] = [
  { id: 'mock-image-standard', capability: 'image', label: 'Mock Image Standard', description: 'Fast simulated stills', unit: 'image', unitCostUsd: 0.02, speedFactor: 0.6 },
  { id: 'mock-image-hd', capability: 'image', label: 'Mock Image HD', description: 'Slower, pricier simulated stills', unit: 'image', unitCostUsd: 0.06, speedFactor: 1.2 },
  { id: 'mock-video-standard', capability: 'video', label: 'Mock Video Standard', description: 'Simulated motion clips', unit: 'second', unitCostUsd: 0.05, maxDurationSec: 10, speedFactor: 1.2 },
  { id: 'mock-video-pro', capability: 'video', label: 'Mock Video Pro', description: 'Slower, pricier simulated motion clips', unit: 'second', unitCostUsd: 0.12, maxDurationSec: 10, speedFactor: 2 },
  { id: 'mock-tts-v1', capability: 'tts', label: 'Mock TTS v1', description: 'Simulated narration with word timings', unit: '1k_chars', unitCostUsd: 0.015, speedFactor: 0.8 },
  { id: 'mock-music-v1', capability: 'music', label: 'Mock Music v1', description: 'Simulated ambient music bed', unit: 'second', unitCostUsd: 0.002, maxDurationSec: 3600, speedFactor: 0.8 },
];

export const MOCK_VOICES: VoiceInfo[] = [
  { id: 'mock-narrator-warm', label: 'Warm Narrator', description: 'Mid pitch, measured pace', basePitch: 165, rateFactor: 1 },
  { id: 'mock-narrator-deep', label: 'Deep Narrator', description: 'Low pitch, slower pace', basePitch: 110, rateFactor: 0.92 },
  { id: 'mock-narrator-bright', label: 'Bright Narrator', description: 'Higher pitch, faster pace', basePitch: 220, rateFactor: 1.1 },
];

function model(id: string): ModelInfo {
  const m = MOCK_MODELS.find((x) => x.id === id);
  if (!m) throw new AppError('PROVIDER_NOT_AVAILABLE', `Unknown mock model "${id}"`);
  return m;
}

export function estimateMockCost(req: GenerationRequest): CostEstimate {
  const m = model(req.model);
  let units = 1;
  if (m.unit === 'second') units = Math.max(1, Math.ceil(req.durationSec ?? 5));
  if (m.unit === '1k_chars') units = Math.max(0.001, (req.text ?? req.prompt).length / 1000);
  return { units, unit: m.unit, unitCostUsd: m.unitCostUsd, amountUsd: round4(units * m.unitCostUsd), simulated: true };
}

function palette(seed: number): [string, string, string] {
  const hues = [[20, 40, 90], [90, 30, 60], [10, 70, 80], [60, 50, 20], [30, 20, 70], [15, 60, 55]];
  const pick = (i: number) => {
    const [r, g, b] = hues[(seed + i * 7) % hues.length];
    const k = 1 + ((seed >>> (i * 3)) % 5) / 3;
    return '0x' + [r, g, b].map((c) => Math.min(255, Math.round(c * k)).toString(16).padStart(2, '0')).join('');
  };
  return [pick(0), pick(1), pick(2)];
}

function wrap(text: string, width: number, maxLines: number): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) { lines.push(cur.trim()); cur = w; } else cur += ' ' + w;
    if (lines.length >= maxLines) break;
  }
  if (lines.length < maxLines && cur.trim()) lines.push(cur.trim());
  return lines.slice(0, maxLines).join('\n');
}

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

async function fontArgs(bold = false): Promise<string> {
  const f = bold ? FONT_BOLD : FONT;
  try { await fs.access(f); return `fontfile=${f}:`; } catch { return ''; }
}

async function renderVisual(kind: 'image' | 'video', req: GenerationRequest, outPath: string, workDir: string, signal?: AbortSignal) {
  const w = req.width ?? 1280;
  const h = req.height ?? 720;
  const seed = hashString(req.prompt + (req.seed ?? 0));
  const [c0, c1, c2] = palette(seed);
  const titleFile = path.join(workDir, 'title.txt');
  const bodyFile = path.join(workDir, 'body.txt');
  // User/LLM text goes through files, never into the filter string.
  await fs.writeFile(titleFile, `${(req.label ?? 'Scene').toUpperCase()}  ·  MOCK ${kind.toUpperCase()}`);
  const fsTitle = Math.round(Math.min(w, h) / 22);
  const fsBody = Math.round(Math.min(w, h) / 17);
  // DejaVu Sans averages ~0.6em per glyph; keep text inside a 90%-width safe area.
  await fs.writeFile(bodyFile, wrap(req.prompt.replace(/\[mock:[a-z-]+\]/g, ''), Math.floor((w * 0.86) / (fsBody * 0.6)), 4));
  const fb = await fontArgs(true);
  const fr = await fontArgs(false);
  const dur = kind === 'video' ? Math.max(1, Math.min(req.durationSec ?? 5, 12)) : 1;
  const grad = `gradients=s=${w}x${h}:c0=${c0}:c1=${c1}:c2=${c2}:n=3:seed=${seed % 100000}:speed=${kind === 'video' ? 0.015 : 0.00001}:d=${dur}:r=24`;
  const vf = [
    'vignette=PI/4',
    `drawbox=x=0:y=ih*0.68:w=iw:h=ih*0.32:color=black@0.45:t=fill`,
    `drawtext=${fb}textfile='${titleFile}':expansion=none:fontcolor=white@0.85:fontsize=${fsTitle}:x=w*0.07:y=h*0.72`,
    `drawtext=${fr}textfile='${bodyFile}':expansion=none:fontcolor=white:fontsize=${fsBody}:line_spacing=${Math.round(fsBody / 3)}:x=w*0.07:y=h*0.72+${fsTitle * 2}`,
  ];
  if (kind === 'video') {
    vf.push(`drawtext=${fr}text='%{pts\\:hms}':fontcolor=white@0.6:fontsize=${fsTitle}:x=w-tw-w*0.04:y=h*0.06`);
    await runFfmpeg(['-f', 'lavfi', '-i', grad, '-vf', vf.join(','), '-t', String(dur), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', outPath], { signal });
  } else {
    await runFfmpeg(['-f', 'lavfi', '-i', grad, '-vf', vf.join(','), '-frames:v', '1', outPath], { signal });
  }
}

export class MockProvider implements GenerationProvider {
  id = 'mock';
  displayName = 'Mock Studio Provider';
  transport = 'mock' as const;
  implemented = true;
  capabilities = ['image', 'video', 'tts', 'music'] as GenerationProvider['capabilities'];
  requiredEnv: string[] = [];
  models = MOCK_MODELS;
  voices = MOCK_VOICES;

  configStatus() { return { configured: true, missingEnv: [] }; }

  estimateCost(req: GenerationRequest) { return estimateMockCost(req); }

  async submit(req: GenerationRequest): Promise<{ externalId: string }> {
    const m = model(req.model);
    if (m.capability !== req.capability) throw new AppError('PROVIDER_NOT_AVAILABLE', `Model ${m.id} does not support ${req.capability}`, { retryable: false });
    if (m.maxDurationSec && req.durationSec && req.durationSec > m.maxDurationSec + 0.01) {
      throw new AppError('VALIDATION_ERROR', `${m.label} supports at most ${m.maxDurationSec}s per clip`);
    }
    const s = (await getSettings(getDb())).mock;
    const text = `${req.prompt} ${req.text ?? ''}`;
    let outcome: 'success' | 'failure' | 'timeout' = 'success';
    if (text.includes('[mock:fail]')) outcome = 'failure';
    else if (text.includes('[mock:timeout]')) outcome = 'timeout';
    else {
      const r = Math.random();
      if (r < s.failureRate) outcome = 'failure';
      else if (r < s.failureRate + s.timeoutRate) outcome = 'timeout';
    }
    const durationMs = Math.round(s.latencyMs * (m.speedFactor ?? 1) * (0.8 + Math.random() * 0.4));
    const [row] = await getDb().insert(mockProviderTasks).values({
      capability: req.capability, model: req.model, request: req as unknown as Record<string, unknown>, outcome, durationMs,
    }).returning();
    return { externalId: row.id };
  }

  async poll(externalId: string, ctx: { signal?: AbortSignal }): Promise<PollResult> {
    const db = getDb();
    const task = await db.query.mockProviderTasks.findFirst({ where: eq(mockProviderTasks.id, externalId) });
    if (!task) return { status: 'failed', progress: 0, error: `Mock task ${externalId} not found`, retryable: true };
    if (task.cancelled) return { status: 'failed', progress: 0, error: 'Cancelled', retryable: false };
    const elapsed = Date.now() - task.createdAt.getTime();
    const queuedMs = Math.min(400, task.durationMs * 0.1);
    if (elapsed < queuedMs) return { status: 'queued', progress: 0, message: 'Queued at provider' };
    if (task.outcome === 'timeout') {
      // Never finishes: progress creeps asymptotically — the worker's deadline must catch it.
      return { status: 'running', progress: Math.min(0.95, 1 - Math.exp(-elapsed / Math.max(1, task.durationMs))), message: 'Rendering (simulated stall)' };
    }
    if (elapsed < task.durationMs) return { status: 'running', progress: Math.min(0.99, elapsed / task.durationMs), message: 'Generating' };
    if (task.outcome === 'failure') {
      return { status: 'failed', progress: 1, error: 'Simulated provider failure: generation capacity error', retryable: true };
    }
    const req = task.request as unknown as GenerationRequest;
    let key = task.outputKey;
    let meta = (task.outputMeta ?? {}) as Record<string, unknown>;
    const ext = { image: 'png', video: 'mp4', tts: 'wav', music: 'wav' }[req.capability];
    const mime = { image: 'image/png', video: 'video/mp4', tts: 'audio/wav', music: 'audio/wav' }[req.capability];
    if (!key) {
      key = `mock-remote/${task.id}.${ext}`;
      const storage = getStorage();
      const out = await storage.ensureDirFor(key);
      const work = await storage.tmpDir('mockgen');
      try {
        if (req.capability === 'image' || req.capability === 'video') {
          await renderVisual(req.capability, req, out, work, ctx.signal);
        } else if (req.capability === 'tts') {
          const voice = MOCK_VOICES.find((v) => v.id === req.voiceId) ?? MOCK_VOICES[0];
          const wpm = Math.round((req.wordsPerMinute ?? 150) * voice.rateFactor);
          const plan = planSpeech(req.text ?? req.prompt, wpm);
          await fs.writeFile(out, encodeWav(synthesizeSpeech(plan.words, plan.durationSec, { basePitch: voice.basePitch, wordsPerMinuteFactor: voice.rateFactor })));
          meta = { words: plan.words, voiceId: voice.id, wordsPerMinute: wpm };
        } else {
          await fs.writeFile(out, encodeWav(synthesizeMusic(Math.max(1, req.durationSec ?? 30), hashString(req.prompt))));
        }
      } finally {
        await fs.rm(work, { recursive: true, force: true });
      }
      await db.update(mockProviderTasks).set({ outputKey: key, outputMeta: meta }).where(eq(mockProviderTasks.id, task.id));
    }
    const words = Array.isArray(meta.words) ? (meta.words as { word: string; start: number; end: number }[]) : undefined;
    return {
      status: 'succeeded', progress: 1,
      output: { kind: 'file', path: getStorage().resolve(key), mime, ext, words, metadata: { mock: true, model: req.model } },
      actualCost: estimateMockCost(req),
    };
  }

  async cancel(externalId: string) {
    await getDb().update(mockProviderTasks).set({ cancelled: true }).where(eq(mockProviderTasks.id, externalId));
  }
}

function round4(n: number) { return Math.round(n * 10000) / 10000; }
