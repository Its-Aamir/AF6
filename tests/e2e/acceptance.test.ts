/**
 * End-to-end acceptance test: the complete Phase 1 workflow through the HTTP
 * API with an in-process worker and the mock providers (no real credits).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { config } from '../../src/server/config';
import { closeDb } from '../../src/server/db/client';
import { probe } from '../../src/server/media/ffmpeg';
import type { Worker } from '../../src/server/queue/worker';
import { resetDb, startWorker, waitFor } from '../helpers';

let app: FastifyInstance;
let worker: Worker;

async function api<T = any>(method: string, url: string, payload?: unknown, expected?: number): Promise<T> {
  const res = await app.inject({ method: method as never, url: `/api${url}`, payload: payload as never });
  if (expected !== undefined) expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(expected);
  else expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
  return res.body ? (res.json() as T) : (undefined as T);
}

const state = (id: string) => api(`GET`, `/projects/${id}`);
const waitStatus = (id: string, statuses: string[], timeoutMs = 60_000) =>
  waitFor(async () => {
    const s = await state(id);
    if (s.project.lastError && !statuses.includes(s.project.status) && !s.project.busy) throw new Error(s.project.lastError);
    return statuses.includes(s.project.status) ? s : null;
  }, { timeoutMs, label: `status ${statuses.join('|')}` });

beforeAll(async () => {
  await resetDb({ latencyMs: 300 });
  app = await buildApp();
  worker = startWorker({ leaseMs: 1500 });
});

afterAll(async () => {
  await worker?.stop();
  await app?.close();
  await closeDb();
});

describe('Phase 1 end-to-end acceptance', () => {
  let projectId = '';
  let recipeId = '';

  it('0. prepares a short Channel Recipe (duplicate + edit)', async () => {
    const recipes = await api<any[]>('GET', '/recipes');
    const doc = recipes.find((r) => r.slug === 'documentary-explainer');
    const dup = await api('POST', `/recipes/${doc.id}/duplicate`, undefined, 201);
    const edited = await api('PUT', `/recipes/${dup.id}`, { name: 'Acceptance Short Doc', description: 'test', config: { ...doc.config, targetDurationSec: 30 } });
    expect(edited.config.targetDurationSec).toBe(30);
    recipeId = edited.id;
    // built-in recipes are protected
    await api('PUT', `/recipes/${doc.id}`, { name: 'x!', config: doc.config }, 409);
  });

  it('1-3. creates a project with a topic and a recipe', async () => {
    await api('POST', '/projects', { title: 'x', inputMode: 'topic', topic: '', recipeId }, 400);
    const p = await api('POST', '/projects', { title: 'The Lost Library of Alexandria', inputMode: 'topic', topic: 'the lost library of Alexandria', recipeId, budgetUsd: 10 }, 201);
    projectId = p.id;
    expect(p.status).toBe('draft');
    expect(p.recipeSnapshot.targetDurationSec).toBe(30);
  });

  it('4. generates a validated mock script / story structure', async () => {
    const r = await api('POST', `/projects/${projectId}/script/generate`, {}, 202);
    expect(r.job.type).toBe('script.generate');
    // Double-click → dedupe returns the same job, not a second one
    const again = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/script/generate`, payload: {} });
    expect([202, 409]).toContain(again.statusCode);
    const s = await waitStatus(projectId, ['scripted']);
    expect(s.project.script.sections.length).toBe(5);
    expect(s.project.script.sections[0].narration.length).toBeGreaterThan(20);
  });

  it('5-6. generates mock narration and measures the real duration', async () => {
    await api('POST', `/projects/${projectId}/narration/generate`, {}, 202);
    const s = await waitStatus(projectId, ['narrated']);
    const narration = s.assets.find((a: any) => a.id === s.project.narrationAssetId);
    expect(narration.mediaType).toBe('audio');
    const measured = await probe(path.join(config.storageDir, narration.storageKey));
    expect(s.project.narrationDurationSec).toBeCloseTo(measured.durationSec!, 2);
    expect(s.project.narrationDurationSec).toBeGreaterThan(15);
    const words = s.project.narrationWords;
    expect(words.length).toBeGreaterThan(40);
    expect(words[words.length - 1].end).toBeLessThanOrEqual(s.project.narrationDurationSec);
  });

  it('7. splits narration into scenes on the narration timeline', async () => {
    await api('POST', `/projects/${projectId}/scenes/segment`, {}, 202);
    const s = await waitStatus(projectId, ['segmented']);
    expect(s.scenes.length).toBeGreaterThan(2);
    expect(s.scenes[0].startSec).toBe(0);
    expect(s.scenes.at(-1).endSec).toBeCloseTo(s.project.narrationDurationSec, 3);
    for (let i = 1; i < s.scenes.length; i++) expect(s.scenes[i].startSec).toBeCloseTo(s.scenes[i - 1].endSec, 3);
  });

  it('8. generates visual briefs (strict-schema validated)', async () => {
    await api('POST', `/projects/${projectId}/visuals/plan`, {}, 202);
    const s = await waitStatus(projectId, ['planned']);
    for (const sc of s.scenes) {
      expect(sc.status).toBe('planned');
      expect(sc.prompt.length).toBeGreaterThan(8);
      expect(['ai_image', 'ai_video']).toContain(sc.visualStrategy);
      expect(sc.provider).toBe('mock');
      expect(sc.brief.camera).toBeTruthy();
    }
    expect(s.scenes.some((sc: any) => sc.visualStrategy === 'ai_video')).toBe(true);
  });

  it('budget guard blocks generation beyond the project budget', async () => {
    await api('PATCH', `/projects/${projectId}`, { budgetUsd: 0.01 });
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/scenes/generate-all` });
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('BUDGET_EXCEEDED');
    await api('PATCH', `/projects/${projectId}`, { budgetUsd: 10 });
  });

  it('9-10. generates mock visuals with visible progress, surviving a worker crash', async () => {
    const est = await api('GET', `/projects/${projectId}/scenes/estimate`);
    expect(est.estimatedUsd).toBeGreaterThan(0);
    const r = await api('POST', `/projects/${projectId}/scenes/generate-all`, undefined, 202);
    expect(r.jobs.length).toBeGreaterThan(2);
    // progress is observable while generating
    await waitFor(async () => {
      const s = await state(projectId);
      return s.project.status === 'producing' && s.scenes.some((sc: any) => sc.status === 'generating' && sc.activeGenerations.some((g: any) => g.externalId));
    }, { label: 'generation in progress' });
    // Simulate a crashed worker mid-generation, then a fresh worker resumes by polling existing external ids.
    await worker.stop({ simulateCrash: true });
    const submittedBefore = (await state(projectId)).scenes.flatMap((sc: any) => sc.activeGenerations).filter((g: any) => g.externalId).length;
    expect(submittedBefore).toBeGreaterThan(0);
    worker = startWorker({ leaseMs: 1500 });
    const s = await waitStatus(projectId, ['assets_ready'], 90_000);
    for (const sc of s.scenes) {
      expect(sc.status).toBe('generated');
      expect(sc.selectedAssetId).toBeTruthy();
      expect(sc.costUsd).toBeGreaterThan(0);
    }
    // No double submission after the crash: each scene generation was submitted exactly once
    const gens = s.scenes.map((sc: any) => sc.lastGeneration);
    expect(gens.every((g: any) => g.submitAttempts === 1)).toBe(true);
  });

  it('11. regenerates, generates alternatives, selects, replaces via upload, and surfaces failures', async () => {
    let s = await state(projectId);
    const scene = s.scenes[1];
    const original = scene.selectedAssetId;
    // alternatives
    const alt = await api('POST', `/scenes/${scene.id}/generate`, { alternatives: 2 }, 202);
    expect(alt.jobs).toHaveLength(2);
    s = await waitStatus(projectId, ['assets_ready']);
    let sc = s.scenes.find((x: any) => x.id === scene.id);
    expect(sc.candidates.length).toBeGreaterThanOrEqual(3);
    expect(sc.selectedAssetId).toBe(original); // alternatives do not override the current pick
    // choose an alternative
    const other = sc.candidates.find((c: any) => c.id !== original);
    await api('POST', `/scenes/${scene.id}/select-asset`, { assetId: other.id });
    // change model + edit prompt, then regenerate
    const models = (await api<any[]>('GET', '/providers')).find((p) => p.id === 'mock').models;
    const cap = sc.visualStrategy === 'ai_video' ? 'video' : 'image';
    const newModel = models.find((m: any) => m.capability === cap && m.id !== sc.model).id;
    await api('PATCH', `/scenes/${scene.id}`, { model: newModel, prompt: `${sc.prompt} (edited)` });
    await api('POST', `/scenes/${scene.id}/generate`, { alternatives: 1 }, 202);
    s = await waitStatus(projectId, ['assets_ready']);
    sc = s.scenes.find((x: any) => x.id === scene.id);
    expect(sc.model).toBe(newModel);
    expect(sc.selectedAssetId).not.toBe(other.id); // regenerate replaces the pick

    // Failure path: forced provider failure → retries → visible error, previous visual kept
    const s3 = s.scenes[2];
    await api('PATCH', `/scenes/${s3.id}`, { prompt: `${s3.prompt} [mock:fail]` });
    await api('POST', `/scenes/${s3.id}/generate`, {}, 202);
    s = await waitFor(async () => {
      const st = await state(projectId);
      const x = st.scenes.find((y: any) => y.id === s3.id);
      return x.activeGenerations.length === 0 && x.error ? st : null;
    }, { timeoutMs: 60_000, label: 'forced failure to settle' });
    const failed = s.scenes.find((y: any) => y.id === s3.id);
    expect(failed.error).toMatch(/Simulated provider failure/);
    expect(failed.selectedAssetId).toBe(s3.selectedAssetId);
    expect(failed.status).toBe('generated');
    const failedJob = s.jobs.find((j: any) => j.sceneId === s3.id && j.status === 'failed');
    expect(failedJob.attempts).toBe(failedJob.maxAttempts);
    await api('PATCH', `/scenes/${s3.id}`, { prompt: s3.prompt });

    // Replace via upload of a user file (validated with ffprobe)
    const png = path.join(config.storageDir, 'tmp', 'upload-test.png');
    await fs.mkdir(path.dirname(png), { recursive: true });
    spawnSync(config.ffmpegPath, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x336699:s=1280x720', '-frames:v', '1', png]);
    const boundary = '----af6test';
    const file = await fs.readFile(png);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="replacement.png"\r\nContent-Type: image/png\r\n\r\n`),
      file, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const s4 = s.scenes[3] ?? s.scenes[0];
    const up = await app.inject({ method: 'POST', url: `/api/assets/upload?projectId=${projectId}&sceneId=${s4.id}`, payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(up.statusCode, up.body).toBe(201);
    // A non-media file is rejected
    const bad = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="evil.png"\r\nContent-Type: image/png\r\n\r\n`), Buffer.from('not an image'), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const rej = await app.inject({ method: 'POST', url: `/api/assets/upload?projectId=${projectId}`, payload: bad, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(rej.statusCode).toBe(415);
    s = await state(projectId);
    expect(s.scenes.find((y: any) => y.id === s4.id).candidates.some((c: any) => c.source === 'uploaded')).toBe(true);

    // Lock prevents edits
    await api('PATCH', `/scenes/${s4.id}`, { locked: true });
    await api('POST', `/scenes/${s4.id}/generate`, {}, 409);
    await api('PATCH', `/scenes/${s4.id}`, { locked: false });
  });

  it('changes a scene duration while keeping the narration timeline tiled', async () => {
    let s = await state(projectId);
    const first = s.scenes[0];
    const target = first.durationSec + 1.5;
    const r = await api('POST', `/scenes/${first.id}/duration`, { durationSec: target });
    expect(Math.abs(r.sceneDurationSec - target)).toBeLessThan(1.2);
    s = await state(projectId);
    expect(s.scenes[0].startSec).toBe(0);
    for (let i = 1; i < s.scenes.length; i++) expect(s.scenes[i].startSec).toBeCloseTo(s.scenes[i - 1].endSec, 3);
    expect(s.scenes.at(-1).endSec).toBeCloseTo(s.project.narrationDurationSec, 3);
  });

  it('13-14. adds captions and mock music', async () => {
    const c = await api('POST', `/projects/${projectId}/captions/generate`);
    expect(c.captions.cues.length).toBeGreaterThan(3);
    await api('POST', `/projects/${projectId}/music/generate`, {}, 202);
    const s = await waitFor(async () => { const st = await state(projectId); return st.project.musicAssetId ? st : null; }, { label: 'music' });
    const music = s.assets.find((a: any) => a.id === s.project.musicAssetId);
    expect(music.durationSec).toBeGreaterThan(s.project.narrationDurationSec);
  });

  it('12. assembles scenes on the timeline', async () => {
    const r = await api('POST', `/projects/${projectId}/timeline/assemble`);
    const s = await state(projectId);
    expect(s.project.status).toBe('assembled');
    expect(r.timeline.video.length).toBe(s.scenes.length);
    expect(r.timeline.music).not.toBeNull();
    expect(r.timeline.captions.cues.length).toBeGreaterThan(3);
    expect(s.project.timelineCurrent).toBe(true);
  });

  it('15. runs QA', async () => {
    await api('POST', `/projects/${projectId}/qa/run`, {}, 202);
    const s = await waitStatus(projectId, ['qa_passed', 'qa_failed']);
    const fails = s.project.qaReport.checks.filter((c: any) => c.status === 'fail');
    expect(fails, JSON.stringify(fails)).toHaveLength(0);
    expect(s.project.status).toBe('qa_passed');
  });

  it('16. renders a final MP4 and verifies it', async () => {
    await api('POST', `/projects/${projectId}/render`, { preset: 'final' }, 202);
    const s = await waitStatus(projectId, ['rendered'], 240_000);
    const render = s.assets.find((a: any) => a.id === s.project.finalRenderAssetId);
    const p = await probe(path.join(config.storageDir, render.storageKey));
    expect(p.hasVideo && p.hasAudio).toBe(true);
    expect(Math.abs(p.durationSec! - s.project.narrationDurationSec)).toBeLessThan(0.3);
    expect(p.width).toBe(1280);
    expect(p.height).toBe(720);
    const dl = await app.inject({ method: 'GET', url: `/api/assets/${render.id}/download`, headers: { range: 'bytes=0-99' } });
    expect(dl.statusCode).toBe(206);
    expect(dl.headers['content-disposition']).toMatch(/attachment/);
  });

  it('17. downloads the project package', async () => {
    await api('POST', `/projects/${projectId}/package`, {}, 202);
    const s = await waitFor(async () => { const st = await state(projectId); return st.project.packageAssetId ? st : null; }, { label: 'package' });
    const res = await app.inject({ method: 'GET', url: `/api/assets/${s.project.packageAssetId}/download` });
    expect(res.statusCode).toBe(200);
    const buf = res.rawPayload;
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    const names = s.assets.find((a: any) => a.id === s.project.packageAssetId).metadata.files as string[];
    expect(names).toEqual(expect.arrayContaining(['final.mp4', 'project.json', 'script.md', 'captions.srt', 'audio/narration.wav', 'audio/music.wav']));
  });

  it('18. reopens the project later without losing state', async () => {
    const before = await state(projectId);
    await app.close();
    app = await buildApp(); // fresh server instance, same database
    const after = await state(projectId);
    expect(after.project.status).toBe('rendered');
    expect(after.project.finalRenderAssetId).toBe(before.project.finalRenderAssetId);
    expect(after.scenes.map((s: any) => s.selectedAssetId)).toEqual(before.scenes.map((s: any) => s.selectedAssetId));
    expect(after.costs.spentUsd).toBeGreaterThan(0);
    const list = await api<any[]>('GET', '/projects');
    expect(list.find((p) => p.id === projectId).hasRender).toBe(true);
    // editing after render makes the render stale (state machine rewinds)
    await api('PATCH', `/projects/${projectId}`, { music: { volume: 0.1 } });
    expect((await state(projectId)).project.status).toBe('assets_ready');
  });
});
