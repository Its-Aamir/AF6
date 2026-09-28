/**
 * Phase 2: real-production flows with ElevenLabs + Claude (local fakes that implement
 * their documented APIs) and Autopilot end-to-end for both workflows:
 *   A) script + your voiceover + your music      B) script/topic only
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app';
import { config } from '../src/server/config';
import { closeDb, getDb } from '../src/server/db/client';
import { probe } from '../src/server/media/ffmpeg';
import { encodeWav, planSpeech, synthesizeSpeech } from '../src/server/media/wav';
import type { Worker } from '../src/server/queue/worker';
import { fakeAnthropic, fakeElevenLabs, type Fake } from './fakes/providers';
import { resetDb, startWorker, waitFor } from './helpers';

let app: FastifyInstance;
let worker: Worker;
let el: Fake;
let claude: Fake;
const VO_SCRIPT = 'Deep beneath the ocean, hot water pours from the seafloor. Around these vents, life thrives without sunlight. Tube worms, crabs and shrimp gather in the warmth.\n\nScientists believe life may have started in places like this. Every expedition reveals something new.';
const voPlan = planSpeech(VO_SCRIPT, 145);

async function api(method: string, url: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url: `/api${url}`, payload: payload as never });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}
async function upload(url: string, file: string, name: string) {
  const b = '----af6p2';
  const payload = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), await fs.readFile(file), Buffer.from(`\r\n--${b}--\r\n`)]);
  const res = await app.inject({ method: 'POST', url: `/api${url}`, payload, headers: { 'content-type': `multipart/form-data; boundary=${b}` } });
  return { status: res.statusCode, body: res.json() };
}
const state = async (id: string) => (await api('GET', `/projects/${id}`)).body;
const untilAutopilotDone = (id: string, timeoutMs = 240_000) => waitFor(async () => { const s = await state(id); return s.project.autopilot && !s.project.autopilot.running ? s : null; }, { timeoutMs, label: 'autopilot finished' });

beforeAll(async () => {
  await resetDb({ latencyMs: 150 });
  app = await buildApp();
  worker = startWorker({ leaseMs: 3000 });
  el = await fakeElevenLabs(undefined, { transcript: voPlan.words.map((w) => ({ text: w.word.replace(/[.,]/g, ''), start: w.start, end: w.end })) });
  claude = await fakeAnthropic();
});
afterAll(async () => { await worker.stop(); await el.close(); await claude.close(); await app.close(); await closeDb(); });

describe('connections: ElevenLabs + Claude', () => {
  it('connects ElevenLabs (voices, TTS models, transcription) and Claude (director model)', async () => {
    const bad = await api('PUT', '/connections/elevenlabs', { fields: { apiKey: 'sk_wrong_key_0000000' }, baseUrl: el.url });
    expect(bad.status).toBe(422);
    const r = await api('PUT', '/connections/elevenlabs', { fields: { apiKey: 'sk_eleven_test_key_000' }, baseUrl: el.url });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await api('PATCH', '/connections/elevenlabs/models', { update: [{ id: 'eleven_multilingual_v2', capability: 'tts', unitCostUsd: 0.3 }] });
    const voices = (await api('GET', '/voices')).body;
    expect(voices.find((v: any) => v.id === 'el:voice123')).toMatchObject({ label: 'Rachel', provider: 'elevenlabs' });
    const c = await api('PUT', '/connections/anthropic', { fields: { apiKey: 'sk-ant-test-key-0000000000' }, baseUrl: claude.url });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const conn = (await api('GET', '/connections')).body.find((x: any) => x.id === 'anthropic');
    expect(conn.models.find((m: any) => m.enabled).id).toBe('claude-opus-5');
  });
});

describe('Autopilot', () => {
  it('B) topic only: Claude writes, ElevenLabs narrates, scenes generate, video renders with a publish report', async () => {
    const recipe = (await api('GET', '/recipes')).body.find((r: any) => r.slug === 'faceless-shorts');
    const p = (await api('POST', '/projects', { title: 'Topic only', inputMode: 'topic', topic: 'hydrothermal vents', recipeId: recipe.id, voiceId: 'el:voice123', budgetUsd: 20 })).body;
    expect((await api('POST', `/projects/${p.id}/autopilot`, { preset: 'draft' })).status).toBe(202);
    const s = await untilAutopilotDone(p.id);
    expect(s.project.autopilot.error, s.project.autopilot.log.map((l: any) => l.message).join('\n')).toBeNull();
    expect(s.project.status).toBe('rendered');
    expect(s.project.script.title).toBe('Claude-written title');
    expect(s.project.narrationTimingSource).toBe('tts_timestamps');
    expect(s.scenes[0].prompt).toMatch(/Claude prompt/);
    const rr = s.project.renderReport;
    expect(rr.integratedLufs).toBeGreaterThan(-18);
    expect(rr.integratedLufs).toBeLessThan(-10);
    expect(rr.publishReady).toBe(false); // draft preset + mock visuals
    expect(rr.simulatedContent.join(' ')).toMatch(/simulated visuals/);
    expect(rr.simulatedContent.join(' ')).not.toMatch(/Narration uses the simulated voice/);
    const costs = await getDb().execute(sql`select provider, simulated from cost_entries where project_id = ${p.id} and kind = 'actual' and provider in ('anthropic','elevenlabs')`);
    expect(costs.rows.some((r: any) => r.provider === 'anthropic' && r.simulated === false)).toBe(true);
    expect(costs.rows.some((r: any) => r.provider === 'elevenlabs' && r.simulated === false)).toBe(true);
    expect(s.project.packageAssetId).toBeTruthy();
  });

  it('A) script + uploaded voiceover + uploaded music: aligned by transcription, music ducked, loudness normalised', async () => {
    const dir = path.join(config.storageDir, '..', 'p2-inputs');
    await fs.mkdir(dir, { recursive: true });
    const vo = path.join(dir, 'my-voiceover.wav');
    await fs.writeFile(vo, encodeWav(synthesizeSpeech(voPlan.words, voPlan.durationSec, { basePitch: 140, wordsPerMinuteFactor: 1 })));
    const music = path.join(dir, 'my-music.mp3');
    spawnSync(config.ffmpegPath, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=220:d=8', '-f', 'lavfi', '-i', 'sine=f=330:d=8', '-filter_complex', 'amix=inputs=2', music]);
    const recipe = (await api('GET', '/recipes')).body.find((r: any) => r.slug === 'documentary-explainer');
    const p = (await api('POST', '/projects', { title: 'My VO', inputMode: 'script', sourceScript: VO_SCRIPT, recipeId: recipe.id, budgetUsd: 20 })).body;
    const v = await upload(`/projects/${p.id}/voiceover`, vo, 'my-voiceover.wav');
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const m = await upload(`/projects/${p.id}/music/upload`, music, 'my-music.mp3');
    expect(m.status, JSON.stringify(m.body)).toBe(201);
    expect((await api('POST', `/projects/${p.id}/autopilot`, { preset: 'final' })).status).toBe(202);
    const s = await untilAutopilotDone(p.id);
    expect(s.project.autopilot.error, s.project.autopilot.log.map((l: any) => l.message).join('\n')).toBeNull();
    expect(s.project.narrationTimingSource).toBe('transcription');
    expect(s.project.narrationAssetId).toBe(v.body.asset.id);
    expect(s.project.narrationDurationSec).toBeCloseTo(voPlan.durationSec, 1);
    expect(s.project.musicAssetId).toBe(m.body.asset.id);
    expect(s.project.script.sections.map((x: any) => x.narration).join(' ')).toContain('Deep beneath the ocean');
    // captions follow the voiceover timing
    const cue = s.project.captions.cues[0];
    expect(Math.abs(cue.start - voPlan.words[0].start)).toBeLessThan(0.1);
    const render = s.assets.find((a: any) => a.id === s.project.finalRenderAssetId);
    const pr = await probe(path.join(config.storageDir, render.storageKey));
    expect(Math.abs(pr.durationSec! - voPlan.durationSec)).toBeLessThan(0.3);
    const rr = s.project.renderReport;
    expect(rr.width).toBe(1280);
    expect(Math.abs(rr.integratedLufs + 14)).toBeLessThan(2.5);
    // Only the visuals are simulated here — voice and music are the user's own.
    expect(rr.simulatedContent).toHaveLength(1);
    expect(rr.simulatedContent[0]).toMatch(/simulated visuals/);
  });

  it('A-lite) without transcription available, falls back to pause-based alignment', async () => {
    await api('DELETE', '/connections/elevenlabs');
    const dir = path.join(config.storageDir, '..', 'p2-inputs');
    const vo = path.join(dir, 'my-voiceover.wav');
    const recipe = (await api('GET', '/recipes')).body.find((r: any) => r.slug === 'documentary-explainer');
    const p = (await api('POST', '/projects', { title: 'Pause align', inputMode: 'script', sourceScript: VO_SCRIPT, recipeId: recipe.id })).body;
    await upload(`/projects/${p.id}/voiceover`, vo, 'vo.wav');
    await api('POST', `/projects/${p.id}/script/generate`);
    await waitFor(async () => (await state(p.id)).project.status === 'scripted', { label: 'scripted' });
    await api('POST', `/projects/${p.id}/narration/generate`);
    const s = await waitFor(async () => { const st = await state(p.id); return st.project.status === 'narrated' ? st : null; }, { label: 'narrated' });
    expect(s.project.narrationTimingSource).toBe('pause_alignment');
    expect(s.project.narrationWords.length).toBe(VO_SCRIPT.split(/\s+/).length);
  });

  it('stops with a clear message when the budget is too small', async () => {
    const recipe = (await api('GET', '/recipes')).body.find((r: any) => r.slug === 'tech-news-brief');
    const p = (await api('POST', '/projects', { title: 'Tiny budget', inputMode: 'topic', topic: 'quantum dots', recipeId: recipe.id, budgetUsd: 0.001 })).body;
    await api('POST', `/projects/${p.id}/autopilot`, { preset: 'draft' });
    const s = await untilAutopilotDone(p.id, 60_000);
    expect(s.project.autopilot.error).toMatch(/budget/i);
    expect(s.project.status).not.toBe('rendered');
  });
});
