/**
 * Provider connections: connect with an API key or MCP sign-in, test, manage
 * models/prices, disconnect. Secrets are write-only from the browser's view.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { projects, scenes, type ConnectionModel } from '../db/schema';
import { AppError, notFound } from '../errors';
import { deleteConnection, getConnection, loadConnection, mergeModels, refreshConnections, upsertConnection } from '../providers/connections';
import { RealProvider } from '../providers/real/base';
import { HiggsfieldMcpProvider, type McpSecret } from '../providers/real/higgsfieldMcp';
import { getRealProvider, listProviders, resolveModel } from '../providers/registry';

const ProviderParam = z.object({ providerId: z.string().min(1).max(64) });

const ModelPatch = z.strictObject({
  id: z.string().min(1).max(200),
  capability: z.enum(['image', 'video', 'tts', 'music', 'llm', 'stt']),
  enabled: z.boolean().optional(),
  unitCostUsd: z.number().min(0).max(1000).nullable().optional(),
  durations: z.array(z.number().int().min(1).max(120)).min(1).max(60).optional(),
  extraInput: z.record(z.string().max(64), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).optional(),
  label: z.string().max(120).optional(),
});

function view(p: RealProvider) {
  const c = getConnection(p.id);
  return {
    id: p.id, displayName: p.displayName, transport: p.transport, capabilities: p.capabilities, notes: p.notes, connection: p.connection,
    defaultBaseUrl: p.defaultBaseUrl,
    status: c?.status ?? 'not_connected',
    secretHint: c?.secretHint ?? null, // never the secret itself
    baseUrl: (c?.config.baseUrl as string | undefined) ?? null,
    lastTestedAt: c?.lastTestedAt ?? null, lastError: c?.lastError ?? null,
    models: c?.models ?? [],
  };
}

function callbackPage(ok: boolean, message: string) {
  const esc = message.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>AF6 Studio</title>
<body style="background:#0a0b0e;color:#e7e9ee;font:14px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:420px"><div style="font-size:18px;font-weight:600;color:${ok ? '#3ecf8e' : '#ff6b6b'}">${ok ? 'Connected' : 'Connection failed'}</div>
<p style="color:#8b93a4">${esc}</p><p style="color:#5d6576">You can close this tab.</p></div>
<script>try{window.opener&&window.opener.postMessage({type:'af6-provider-connected',ok:${ok}},'*')}catch(e){};${ok ? 'setTimeout(()=>window.close(),1500)' : ''}</script></body>`;
}

async function applyTest(p: RealProvider, secret: unknown, cfg: Record<string, unknown>) {
  const db = getDb();
  const existing = getConnection(p.id)?.models ?? [];
  const result = await p.test(secret, cfg);
  await upsertConnection(db, p.id, { status: 'connected', models: mergeModels(existing, result.models), lastError: null, lastTestedAt: new Date(), config: { ...cfg, ...(result.config ?? {}) } });
  return result.message;
}

export async function registerConnectionRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get('/connections', async () => {
    await refreshConnections(db, 0);
    return listProviders().filter((p): p is RealProvider => p instanceof RealProvider).map(view);
  });

  /** Connect (or replace credentials). Validates against the provider before saving. */
  app.put('/connections/:providerId', async (req) => {
    const { providerId } = ProviderParam.parse(req.params);
    const p = getRealProvider(providerId);
    const body = z.object({ fields: z.record(z.string().max(64), z.string().max(4096)), baseUrl: z.string().url().max(500).optional() }).parse(req.body ?? {});
    const parsed = p.parseCredentials(body.fields);
    const cfg = { ...(parsed.config ?? {}), ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}) };

    if (p instanceof HiggsfieldMcpProvider && !(parsed.secret as McpSecret).bearerToken) {
      // OAuth: persist a pending connection so the SDK can store PKCE/client registration, then send the user to sign in.
      await upsertConnection(db, p.id, { status: 'authorization_required', secret: parsed.secret, secretHint: parsed.hint, config: cfg, lastError: null });
      const { secret } = await loadConnection(db, p.id);
      const session = await p.openSession(secret as McpSecret, (cfg.baseUrl as string) || p.defaultBaseUrl);
      if (session.authorizationUrl) return { status: 'authorization_required', authorizationUrl: session.authorizationUrl };
      await session.client?.close().catch(() => undefined);
      await refreshConnections(db, 0);
      const message = await applyTest(p, (await loadConnection(db, p.id)).secret, cfg);
      return { status: 'connected', message };
    }

    let message: string;
    try {
      const result = await p.test(parsed.secret, cfg);
      await upsertConnection(db, p.id, {
        status: 'connected', secret: parsed.secret, secretHint: parsed.hint, config: { ...cfg, ...(result.config ?? {}) },
        models: mergeModels(getConnection(p.id)?.models ?? [], result.models), lastError: null, lastTestedAt: new Date(),
      });
      message = result.message;
    } catch (e) {
      // Bad credentials are not stored.
      throw e instanceof AppError ? e : new AppError('PROVIDER_ERROR', (e as Error).message);
    }
    return { status: 'connected', message };
  });

  app.post('/connections/:providerId/test', async (req) => {
    const { providerId } = ProviderParam.parse(req.params);
    const p = getRealProvider(providerId);
    const { row, secret } = await loadConnection(db, p.id);
    if (!row || !secret) throw new AppError('INVALID_STATE', `${p.displayName} is not connected.`);
    try {
      const message = await applyTest(p, secret, row.config);
      return { status: 'connected', message };
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError('PROVIDER_ERROR', (e as Error).message);
      const authUrl = (err.details as { authorizationUrl?: string } | undefined)?.authorizationUrl;
      await upsertConnection(db, p.id, { status: authUrl ? 'authorization_required' : 'error', lastError: err.message, lastTestedAt: new Date() });
      if (authUrl) return { status: 'authorization_required', authorizationUrl: authUrl };
      throw err;
    }
  });

  app.patch('/connections/:providerId/models', async (req) => {
    const { providerId } = ProviderParam.parse(req.params);
    const p = getRealProvider(providerId);
    const body = z.object({ update: z.array(ModelPatch).max(500).default([]), add: z.array(ModelPatch.extend({ label: z.string().min(1).max(120) })).max(50).default([]), remove: z.array(z.object({ id: z.string(), capability: z.enum(['image', 'video', 'tts', 'music', 'llm', 'stt']) })).max(50).default([]) }).parse(req.body ?? {});
    await refreshConnections(db, 0);
    const c = getConnection(p.id);
    if (!c) throw new AppError('INVALID_STATE', `${p.displayName} is not connected.`);
    let models: ConnectionModel[] = c.models.map((m) => {
      const u = body.update.find((x) => x.id === m.id && x.capability === m.capability);
      return u ? { ...m, ...Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined)) } as ConnectionModel : m;
    });
    // The AI Director uses exactly one model: enabling one disables the others.
    const llmOn = body.update.find((u) => u.capability === 'llm' && u.enabled);
    if (llmOn) models = models.map((m) => (m.capability === 'llm' ? { ...m, enabled: m.id === llmOn.id } : m));
    for (const a of body.add) {
      if (!(p.capabilities as string[]).includes(a.capability)) throw new AppError('VALIDATION_ERROR', `${p.displayName} does not support ${a.capability}`);
      if (models.some((m) => m.id === a.id && m.capability === a.capability)) throw new AppError('CONFLICT', `Model ${a.id} already exists`);
      models.push({ id: a.id, capability: a.capability, label: a.label ?? a.id, enabled: a.enabled ?? true, unitCostUsd: a.unitCostUsd ?? null, unit: a.capability === 'video' ? 'second' : a.capability === 'tts' ? '1k_chars' : 'image', durations: a.capability === 'video' ? (a.durations ?? [5]) : undefined, extraInput: a.extraInput, source: 'custom' });
    }
    models = models.filter((m) => !(m.source === 'custom' && body.remove.some((r) => r.id === m.id && r.capability === m.capability)));
    await upsertConnection(db, p.id, { models });
    await refreshConnections(db, 0);
    return view(p);
  });

  app.delete('/connections/:providerId', async (req, reply) => {
    const { providerId } = ProviderParam.parse(req.params);
    const p = getRealProvider(providerId);
    await deleteConnection(db, p.id);
    return reply.status(204).send();
  });

  /** OAuth redirect target for MCP sign-in. */
  app.get('/connections/oauth/callback', async (req, reply) => {
    const q = z.object({ code: z.string().max(4096).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional(), error_description: z.string().max(1000).optional() }).parse(req.query);
    reply.type('text/html');
    if (q.error) return callbackPage(false, `${q.error}${q.error_description ? `: ${q.error_description}` : ''}`);
    if (!q.code || !q.state) return callbackPage(false, 'Missing authorization code.');
    const providerId = q.state.split('.')[0];
    let p: RealProvider;
    try { p = getRealProvider(providerId); } catch { return callbackPage(false, 'Unknown provider in OAuth state.'); }
    if (!(p instanceof HiggsfieldMcpProvider)) return callbackPage(false, 'Provider does not use OAuth.');
    const { row, secret } = await loadConnection(db, p.id);
    if (!row || (secret as McpSecret | undefined)?.oauth?.state !== q.state) return callbackPage(false, 'OAuth state mismatch — start the connection again.');
    try {
      await p.finishAuthorization(q.code);
      await refreshConnections(db, 0);
      const fresh = await loadConnection(db, p.id);
      const message = await applyTest(p, fresh.secret, fresh.row!.config);
      return callbackPage(true, message);
    } catch (e) {
      await upsertConnection(db, p.id, { status: 'error', lastError: (e as Error).message });
      return callbackPage(false, (e as Error).message);
    }
  });

  /** Switch every unlocked scene of one kind (image/video) in a project to a model, and make it the project default. */
  app.post('/projects/:id/scenes/model', async (req) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const b = z.object({ capability: z.enum(['image', 'video']), provider: z.string().min(1).max(64), model: z.string().min(1).max(200) }).parse(req.body ?? {});
    resolveModel(b.capability, b.provider, b.model);
    return db.transaction(async (tx) => {
      const [p] = await tx.select().from(projects).where(eq(projects.id, id)).for('update');
      if (!p) throw notFound('Project');
      const strategy = b.capability === 'video' ? 'ai_video' : 'ai_image';
      const updated = await tx.update(scenes).set({ provider: b.provider, model: b.model, updatedAt: new Date() })
        .where(and(eq(scenes.projectId, id), eq(scenes.locked, false), eq(scenes.visualStrategy, strategy), inArray(scenes.status, ['pending', 'planned', 'generated', 'failed'])))
        .returning({ id: scenes.id });
      await tx.update(projects).set({ recipeSnapshot: { ...p.recipeSnapshot, defaults: { ...p.recipeSnapshot.defaults, [b.capability]: { provider: b.provider, model: b.model } } }, updatedAt: new Date() }).where(eq(projects.id, id));
      return { updatedScenes: updated.length };
    });
  });
}
