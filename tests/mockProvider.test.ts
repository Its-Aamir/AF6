import fs from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/server/db/client';
import { probe } from '../src/server/media/ffmpeg';
import { MockProvider } from '../src/server/providers/mock';
import { resolveModel } from '../src/server/providers/registry';
import type { GenerationRequest, PollResult } from '../src/server/providers/types';
import { resetDb, waitFor } from './helpers';

const mock = new MockProvider();
const pollUntilDone = (id: string, timeoutMs = 20_000) => waitFor(async () => { const r = await mock.poll(id, {}); return r.status === 'succeeded' || r.status === 'failed' ? r : null; }, { timeoutMs }) as Promise<PollResult>;

beforeEach(async () => { await resetDb({ latencyMs: 200 }); });
afterAll(async () => { await closeDb(); });

describe('mock provider', () => {
  it('generates a real image with progress while polling', async () => {
    const { externalId } = await mock.submit({ capability: 'image', model: 'mock-image-standard', prompt: 'a lighthouse at dusk', width: 640, height: 360, label: 'Scene 1' });
    const first = await mock.poll(externalId, {});
    expect(['queued', 'running']).toContain(first.status);
    const r = await pollUntilDone(externalId);
    expect(r.status).toBe('succeeded');
    const p = await probe((r.output as { path: string }).path);
    expect(p.width).toBe(640);
    expect(r.actualCost?.simulated).toBe(true);
    expect(r.actualCost?.amountUsd).toBe(0.02);
  });

  it('generates a video of the requested length', async () => {
    const { externalId } = await mock.submit({ capability: 'video', model: 'mock-video-standard', prompt: 'waves', width: 320, height: 180, durationSec: 3 });
    const r = await pollUntilDone(externalId);
    const p = await probe((r.output as { path: string }).path);
    expect(p.durationSec).toBeCloseTo(3, 0);
    expect(r.actualCost?.amountUsd).toBeCloseTo(0.15, 5);
  });

  it('synthesises TTS with word timings whose audio length is measurable', async () => {
    const req: GenerationRequest = { capability: 'tts', model: 'mock-tts-v1', prompt: 'n', text: 'Hello there. This is a test of narration timing.', voiceId: 'mock-narrator-deep', wordsPerMinute: 150 };
    const { externalId } = await mock.submit(req);
    const r = await pollUntilDone(externalId);
    const out = r.output!;
    expect(out.words).toHaveLength(9);
    const p = await probe((out as { path: string }).path);
    expect(p.hasAudio).toBe(true);
    expect(p.durationSec!).toBeGreaterThan(out.words!.at(-1)!.end);
  });

  it('simulates failures and never-finishing (timeout) tasks', async () => {
    const f = await mock.submit({ capability: 'image', model: 'mock-image-standard', prompt: 'x [mock:fail]' });
    const fr = await pollUntilDone(f.externalId);
    expect(fr.status).toBe('failed');
    expect(fr.retryable).toBe(true);
    const t = await mock.submit({ capability: 'image', model: 'mock-image-standard', prompt: 'x [mock:timeout]' });
    await new Promise((r) => setTimeout(r, 600));
    const tr = await mock.poll(t.externalId, {});
    expect(tr.status).toBe('running');
    expect(tr.progress).toBeLessThan(1);
  });

  it('respects model limits and capabilities', async () => {
    await expect(mock.submit({ capability: 'video', model: 'mock-video-standard', prompt: 'x', durationSec: 30 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(mock.submit({ capability: 'image', model: 'mock-video-standard', prompt: 'x' })).rejects.toMatchObject({ code: 'PROVIDER_NOT_AVAILABLE' });
  });

  it('registry refuses unimplemented and real providers in tests', () => {
    expect(() => resolveModel('video', 'google-veo', 'any')).toThrow(/not implemented/);
    expect(() => resolveModel('video', 'nope', 'any')).toThrow(/Unknown provider/);
    expect(() => resolveModel('video', 'mock', 'mock-image-standard')).toThrow(/not a video model/);
  });

  it('cleans up', async () => { await fs.rm('/nonexistent', { force: true }); });
});
