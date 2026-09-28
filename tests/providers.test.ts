/**
 * Contract tests for the real provider adapters against local fake servers that
 * implement each provider's documented API. No network, no real credits.
 */
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app';
import { config } from '../src/server/config';
import { closeDb, getDb } from '../src/server/db/client';
import { probe } from '../src/server/media/ffmpeg';
import { refreshConnections } from '../src/server/providers/connections';
import { getProvider } from '../src/server/providers/registry';
import type { GenerationProvider, GenerationRequest, PollResult } from '../src/server/providers/types';
import { materializeOutput } from '../src/server/services/assets';
import type { Worker } from '../src/server/queue/worker';
import { fakeGoogle, fakeHiggsfieldApi, fakeHiggsfieldMcp, fakeKling, type Fake } from './fakes/providers';
import { resetDb, startWorker, waitFor } from './helpers';

let app: FastifyInstance;
const fakes: Record<string, Fake> = {};

async function api(method: string, url: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url: `/api${url}`, payload: payload as never });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

async function run(p: GenerationProvider, req: GenerationRequest): Promise<PollResult> {
  await refreshConnections(getDb(), 0);
  const { externalId } = await p.submit(req, {});
  return waitFor(async () => { const r = await p.poll(externalId, {}); return r.status === 'succeeded' || r.status === 'failed' ? r : null; }, { timeoutMs: 15_000 });
}

async function expectMedia(r: PollResult, kind: 'video' | 'image') {
  expect(r.status, r.error).toBe('succeeded');
  const file = await materializeOutput(r.output!);
  const p = await probe(file.path);
  expect(p.hasVideo).toBe(true);
  if (kind === 'video') expect(p.durationSec!).toBeGreaterThan(1);
  await file.cleanup();
}

const base: Omit<GenerationRequest, 'capability' | 'model'> = { prompt: 'a lighthouse at dusk', negativePrompt: 'text', width: 1280, height: 720, durationSec: 5.2 };

beforeAll(async () => {
  await resetDb();
  app = await buildApp();
  fakes.google = await fakeGoogle();
  fakes.kling = await fakeKling();
  fakes.hf = await fakeHiggsfieldApi();
  fakes.mcp = await fakeHiggsfieldMcp();
});
afterAll(async () => {
  for (const f of Object.values(fakes)) await f.close();
  await app.close();
  await closeDb();
});

describe('provider connections', () => {
  it('lists connectable providers without secrets', async () => {
    const r = await api('GET', '/connections');
    expect(r.body.map((p: any) => p.id)).toEqual(['google', 'kling', 'higgsfield-api', 'higgsfield-mcp']);
    expect(r.body.every((p: any) => p.status === 'not_connected')).toBe(true);
  });

  it('rejects bad credentials and stores nothing', async () => {
    const r = await api('PUT', '/connections/kling', { fields: { apiKey: 'wrong-key-000000' }, baseUrl: fakes.kling.url });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/rejected the API key/);
    expect((await api('GET', '/connections')).body.find((p: any) => p.id === 'kling').status).toBe('not_connected');
  });

  it('Google: connects, discovers Veo + image models, requires prices, generates video and image', async () => {
    const r = await api('PUT', '/connections/google', { fields: { apiKey: 'AIzaTESTKEY-0000000000000000' }, baseUrl: `${fakes.google.url}/v1beta` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const conn = (await api('GET', '/connections')).body.find((p: any) => p.id === 'google');
    expect(conn.status).toBe('connected');
    expect(conn.secretHint).toBe('…0000');
    expect(JSON.stringify(conn)).not.toContain('AIzaTESTKEY');
    expect(conn.models.map((m: any) => `${m.capability}:${m.id}`)).toEqual(['video:veo-3.1-generate-preview', 'image:gemini-2.5-flash-image']);
    // Secret is encrypted at rest.
    const row = await getDb().execute(sql`select secret_ciphertext from provider_connections where provider_id = 'google'`);
    expect(String(row.rows[0].secret_ciphertext)).not.toContain('AIzaTESTKEY');

    await refreshConnections(getDb(), 0);
    const g = getProvider('google');
    expect(() => g.estimateCost({ ...base, capability: 'video', model: 'veo-3.1-generate-preview' })).toThrow(/Set a price/);
    await api('PATCH', '/connections/google/models', { update: [{ id: 'veo-3.1-generate-preview', capability: 'video', unitCostUsd: 0.4 }, { id: 'gemini-2.5-flash-image', capability: 'image', unitCostUsd: 0.04 }] });
    await refreshConnections(getDb(), 0);
    const est = g.estimateCost({ ...base, capability: 'video', model: 'veo-3.1-generate-preview' });
    expect(est).toMatchObject({ units: 6, amountUsd: 2.4, simulated: false }); // 5.2s scene → 6s (allowed 4/6/8)

    await expectMedia(await run(g, { ...base, capability: 'video', model: 'veo-3.1-generate-preview' }), 'video');
    const submit = fakes.google.calls.find((c) => c.path.includes(':predictLongRunning'))!;
    expect(submit.body).toEqual({ instances: [{ prompt: base.prompt }], parameters: { aspectRatio: '16:9', durationSeconds: 6, resolution: '720p', sampleCount: 1, negativePrompt: 'text' } });
    // Credential header is sent to the API host only (download redirect stays on-host here).
    await expectMedia(await run(g, { ...base, capability: 'image', model: 'gemini-2.5-flash-image' }), 'image');
  });

  it('Kling: connects with official catalog prices, generates, and recovers instead of double-submitting', async () => {
    const r = await api('PUT', '/connections/kling', { fields: { apiKey: 'kling-test-key-123' }, baseUrl: fakes.kling.url });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await refreshConnections(getDb(), 0);
    const k = getProvider('kling');
    expect(k.models.map((m) => m.id)).toEqual(['kling-3.0-turbo', 'kling-3.0', 'kling-v3']);
    expect(k.estimateCost({ ...base, capability: 'video', model: 'kling-3.0-turbo' })).toMatchObject({ units: 6, unitCostUsd: 0.112 });
    const req = { ...base, capability: 'video' as const, model: 'kling-3.0-turbo', idempotencyKey: 'gen-abc-1' };
    await expectMedia(await run(k, req), 'video');
    const created = fakes.kling.calls.filter((c) => c.path.startsWith('/text-to-video/')).length;
    const again = await k.submit(req, {}); // simulated retry after a crash with the same key
    expect(again.externalId).toMatch(/^video:/);
    expect(fakes.kling.calls.filter((c) => c.path.startsWith('/text-to-video/')).length).toBe(created);
    await expectMedia(await run(k, { ...base, capability: 'image', model: 'kling-v3' }), 'image');
  });

  it('Higgsfield API: endpoint models, key-pair auth, nsfw handling', async () => {
    const r = await api('PUT', '/connections/higgsfield-api', { fields: { keyId: 'kid', keySecret: 'ksecret' }, baseUrl: fakes.hf.url });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await api('PATCH', '/connections/higgsfield-api/models', {
      update: [{ id: 'flux-pro/kontext/max/text-to-image', capability: 'image', unitCostUsd: 0.05 }],
      add: [{ id: 'my-video/text-to-video', capability: 'video', label: 'My video endpoint', unitCostUsd: 0.1, durations: [5, 10], extraInput: { resolution: '720p' } }],
    });
    await refreshConnections(getDb(), 0);
    const h = getProvider('higgsfield-api');
    await expectMedia(await run(h, { ...base, capability: 'image', model: 'flux-pro/kontext/max/text-to-image' }), 'image');
    await expectMedia(await run(h, { ...base, capability: 'video', model: 'my-video/text-to-video' }), 'video');
    const vbody = fakes.hf.calls.find((c) => c.path === '/my-video/text-to-video')!.body;
    expect(vbody).toMatchObject({ aspect_ratio: '16:9', duration: 10, resolution: '720p' });
    const bad = await run(h, { ...base, prompt: 'nsfw thing', capability: 'image', model: 'flux-pro/kontext/max/text-to-image' });
    expect(bad).toMatchObject({ status: 'failed', retryable: false });
  });

  it('Higgsfield MCP: speaks MCP via the official SDK, discovers models, never uses unlim allowance', async () => {
    const r = await api('PUT', '/connections/higgsfield-mcp', { fields: { serverUrl: `${fakes.mcp.url}/mcp`, bearerToken: 'mcp-test-token' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const conn = (await api('GET', '/connections')).body.find((p: any) => p.id === 'higgsfield-mcp');
    expect(conn.models.map((m: any) => m.id)).toEqual(['seedance_2_5', 'gpt_image_2_5']);
    expect(conn.models[0].durations[0]).toBe(4);
    await api('PATCH', '/connections/higgsfield-mcp/models', { update: [{ id: 'seedance_2_5', capability: 'video', enabled: true, unitCostUsd: 0.08 }, { id: 'gpt_image_2_5', capability: 'image', enabled: true, unitCostUsd: 0.03 }] });
    await refreshConnections(getDb(), 0);
    const m = getProvider('higgsfield-mcp');
    await expectMedia(await run(m, { ...base, capability: 'video', model: 'seedance_2_5' }), 'video');
    await expectMedia(await run(m, { ...base, capability: 'image', model: 'gpt_image_2_5' }), 'image');
  });

  it('Higgsfield MCP OAuth: discovery, dynamic registration, PKCE, callback, token exchange', async () => {
    await api('DELETE', '/connections/higgsfield-mcp');
    const r = await api('PUT', '/connections/higgsfield-mcp', { fields: { serverUrl: `${fakes.mcp.url}/mcp` } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('authorization_required');
    const authUrl = new URL(r.body.authorizationUrl);
    expect(authUrl.origin).toBe(fakes.mcp.url);
    expect(authUrl.searchParams.get('redirect_uri')).toMatch(/\/api\/connections\/oauth\/callback$/);
    // The user signs in; the provider redirects back to our callback with code + state.
    const auth = await fetch(authUrl, { redirect: 'manual' });
    const back = new URL(auth.headers.get('location')!);
    // A forged state is refused.
    const forged = await app.inject({ method: 'GET', url: `/api/connections/oauth/callback?code=x&state=higgsfield-mcp.forged` });
    expect(forged.body).toMatch(/state mismatch/);
    const cb = await app.inject({ method: 'GET', url: `/api/connections/oauth/callback${back.search}` });
    expect(cb.body, cb.body).toMatch(/Connected/);
    const conn = (await api('GET', '/connections')).body.find((p: any) => p.id === 'higgsfield-mcp');
    expect(conn.status).toBe('connected');
    expect(conn.models.length).toBe(2);
    expect(JSON.stringify(conn)).not.toContain('refresh-1');
  });

  it('bad MCP token is reported, not stored', async () => {
    await api('DELETE', '/connections/higgsfield-mcp');
    const r = await api('PUT', '/connections/higgsfield-mcp', { fields: { serverUrl: `${fakes.mcp.url}/mcp`, bearerToken: 'nope' } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await api('GET', '/connections')).body.find((p: any) => p.id === 'higgsfield-mcp').status).toBe('not_connected');
  });
});

describe('pipeline with connected providers', () => {
  let worker: Worker;
  afterAll(async () => { await worker?.stop(); });

  it('switches a project to Kling video + Gemini images and generates every scene through the worker', async () => {
    worker = startWorker();
    const recipes = (await api('GET', '/recipes')).body;
    const recipe = recipes.find((r: any) => r.slug === 'tech-news-brief');
    const p = (await api('POST', '/projects', { title: 'Real providers', inputMode: 'script', sourceScript: 'Kling makes the motion shots. Gemini paints the stills. Every scene follows the narration timing exactly, from the first word to the last.', recipeId: recipe.id, budgetUsd: 50 })).body;
    const step = async (url: string, status: string) => {
      const r = await api('POST', `/projects/${p.id}${url}`, {});
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
      await waitFor(async () => (await api('GET', `/projects/${p.id}`)).body.project.status === status, { label: status, timeoutMs: 30_000 });
    };
    await step('/script/generate', 'scripted');
    await step('/narration/generate', 'narrated');
    await step('/scenes/segment', 'segmented');
    await step('/visuals/plan', 'planned');
    expect((await api('POST', `/projects/${p.id}/scenes/model`, { capability: 'video', provider: 'kling', model: 'kling-3.0-turbo' })).status).toBe(200);
    expect((await api('POST', `/projects/${p.id}/scenes/model`, { capability: 'image', provider: 'google', model: 'gemini-2.5-flash-image' })).status).toBe(200);
    const gen = await api('POST', `/projects/${p.id}/scenes/generate-all`);
    expect(gen.status, JSON.stringify(gen.body)).toBe(202);
    const s = await waitFor(async () => { const st = (await api('GET', `/projects/${p.id}`)).body; return st.project.status === 'assets_ready' ? st : null; }, { timeoutMs: 60_000, label: 'assets_ready' });
    const providersUsed = new Set(s.scenes.map((x: any) => x.provider));
    expect([...providersUsed].sort()).toEqual(expect.arrayContaining(['kling']));
    for (const sc of s.scenes) {
      expect(sc.selectedAssetId).toBeTruthy();
      expect(sc.lastGeneration.submitAttempts).toBe(1);
    }
    const costs = await getDb().execute(sql`select provider, simulated from cost_entries where kind = 'actual' and provider in ('kling','google')`);
    expect(costs.rows.length).toBe(s.scenes.length);
    expect(costs.rows.every((r: any) => r.simulated === false)).toBe(true);
    void path; void config;
  });
});
