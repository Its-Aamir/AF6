/**
 * Local fake provider servers that implement each provider's DOCUMENTED contract
 * (see adapter headers). Used by contract tests so real adapters are exercised
 * end-to-end without network access or real credits.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../../src/server/config';

export interface Fake { url: string; close: () => Promise<void>; calls: { method: string; path: string; headers: http.IncomingHttpHeaders; body: any }[] }

let media: { mp4: Buffer; png: Buffer } | null = null;
export function sampleMedia() {
  if (media) return media;
  const dir = path.join(config.storageDir, '..', 'fake-media');
  fs.mkdirSync(dir, { recursive: true });
  const mp4 = path.join(dir, 'v.mp4');
  const png = path.join(dir, 'i.png');
  spawnSync(config.ffmpegPath, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=3:r=24', '-pix_fmt', 'yuv420p', mp4]);
  spawnSync(config.ffmpegPath, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x336699:s=320x180', '-frames:v', '1', png]);
  media = { mp4: fs.readFileSync(mp4), png: fs.readFileSync(png) };
  return media;
}

async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: any, fake: Fake) => unknown): Promise<Fake> {
  const fake: Fake = { url: '', calls: [], close: async () => {} };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    fake.calls.push({ method: req.method!, path: req.url!, headers: req.headers, body });
    try { await handler(req, res, body, fake); } catch (e) { res.writeHead(500).end(String(e)); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fake.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  fake.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return fake;
}

const json = (res: http.ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

// ── Google Gemini API ────────────────────────────────────────────────────────
export function fakeGoogle(key = 'AIzaTESTKEY-0000000000000000') {
  const ops = new Map<string, number>();
  return serve((req, res, body, fake) => {
    const u = new URL(req.url!, fake.url);
    if (req.headers['x-goog-api-key'] !== key && !u.pathname.startsWith('/cdn/')) return json(res, 400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } });
    if (u.pathname === '/v1beta/models' && req.method === 'GET') {
      return json(res, 200, { models: [
        { name: 'models/veo-3.1-generate-preview', displayName: 'Veo 3.1', supportedGenerationMethods: ['predictLongRunning'] },
        { name: 'models/gemini-2.5-flash-image', displayName: 'Gemini 2.5 Flash Image', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
      ] });
    }
    let m = /^\/v1beta\/models\/([^/:]+):predictLongRunning$/.exec(u.pathname);
    if (m && req.method === 'POST') {
      if (!body?.instances?.[0]?.prompt || !body?.parameters?.durationSeconds || body.parameters.seed !== undefined) return json(res, 400, { error: { message: 'bad request shape' } });
      const name = `models/${m[1]}/operations/${randomUUID()}`;
      ops.set(name, 0);
      return json(res, 200, { name });
    }
    m = /^\/v1beta\/(models\/[^/]+\/operations\/[^/]+)$/.exec(u.pathname);
    if (m) {
      const n = (ops.get(m[1]) ?? 0) + 1;
      ops.set(m[1], n);
      if (n < 2) return json(res, 200, { name: m[1], done: false });
      return json(res, 200, { name: m[1], done: true, response: { '@type': 'type.googleapis.com/google.ai.generativelanguage.v1beta.PredictLongRunningResponse', generateVideoResponse: { generatedSamples: [{ video: { uri: `${fake.url}/v1beta/files/abc:download?alt=media` } }] } } });
    }
    if (u.pathname === '/v1beta/files/abc:download') return res.writeHead(302, { Location: '/cdn/video.mp4' }).end();
    if (u.pathname === '/cdn/video.mp4') return res.writeHead(200, { 'Content-Type': 'video/mp4' }).end(sampleMedia().mp4);
    m = /^\/v1beta\/models\/([^/:]+):generateContent$/.exec(u.pathname);
    if (m) {
      if (!body?.generationConfig?.responseModalities?.includes('IMAGE')) return json(res, 400, { error: { message: 'missing IMAGE modality' } });
      return json(res, 200, { candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: sampleMedia().png.toString('base64') } }] }, finishReason: 'STOP' }] });
    }
    json(res, 404, { error: { message: 'not found' } });
  });
}

// ── Kling (new API standard + legacy image endpoints) ────────────────────────
export function fakeKling(apiKey = 'kling-test-key-123') {
  const tasks = new Map<string, { polls: number; external?: string }>();
  return serve((req, res, body, fake) => {
    const u = new URL(req.url!, fake.url);
    if (u.pathname.startsWith('/cdn/')) return res.writeHead(200).end(u.pathname.endsWith('.mp4') ? sampleMedia().mp4 : sampleMedia().png);
    if (req.headers.authorization !== `Bearer ${apiKey}`) return json(res, 401, { code: 1002, message: 'Authorization is invalid', request_id: 'r' });
    const m = /^\/text-to-video\/([\w.-]+)$/.exec(u.pathname);
    if (m && req.method === 'POST') {
      if (typeof body?.prompt !== 'string' || !body?.settings?.duration || !['16:9', '9:16', '1:1'].includes(body.settings.aspect_ratio)) return json(res, 400, { code: 1201, message: 'invalid params' });
      const id = String(Date.now()) + Math.floor(Math.random() * 1000);
      tasks.set(id, { polls: 0, external: body.options?.external_task_id });
      return json(res, 200, { code: 0, message: 'SUCCEED', request_id: 'r', data: { id, status: 'submitted' } });
    }
    if (u.pathname === '/tasks' && req.method === 'GET') {
      const ext = u.searchParams.get('external_task_ids');
      if (ext) return json(res, 200, { code: 0, data: [...tasks.entries()].filter(([, t]) => t.external === ext).map(([id]) => ({ id, status: 'processing' })) });
      const id = u.searchParams.get('task_ids')!;
      const t = tasks.get(id);
      if (!t) return json(res, 200, { code: 0, data: [] });
      t.polls++;
      if (t.polls < 2) return json(res, 200, { code: 0, data: [{ id, status: 'processing' }] });
      return json(res, 200, { code: 0, data: [{ id, status: 'succeeded', outputs: [{ type: 'video', id: 'v1', url: `${fake.url}/cdn/out.mp4`, duration: '5' }] }] });
    }
    if (u.pathname === '/v1/images/generations' && req.method === 'POST') {
      if (!body?.model_name || !body?.prompt) return json(res, 400, { code: 1201, message: 'invalid' });
      const id = `img${Date.now()}`;
      tasks.set(id, { polls: 0 });
      return json(res, 200, { code: 0, data: { task_id: id, task_status: 'submitted' } });
    }
    const im = /^\/v1\/images\/generations\/(\w+)$/.exec(u.pathname);
    if (im) {
      const t = tasks.get(im[1])!;
      t.polls++;
      if (t.polls < 2) return json(res, 200, { code: 0, data: { task_id: im[1], task_status: 'processing' } });
      return json(res, 200, { code: 0, data: { task_id: im[1], task_status: 'succeed', task_result: { images: [{ index: 0, url: `${fake.url}/cdn/out.png` }] } } });
    }
    json(res, 404, { code: 1202, message: 'not found' });
  });
}

// ── Higgsfield platform API ──────────────────────────────────────────────────
export function fakeHiggsfieldApi(creds = 'kid:ksecret') {
  const reqs = new Map<string, { polls: number; video: boolean; nsfw: boolean }>();
  return serve((req, res, body, fake) => {
    const u = new URL(req.url!, fake.url);
    if (u.pathname.startsWith('/cdn/')) return res.writeHead(200).end(u.pathname.endsWith('.mp4') ? sampleMedia().mp4 : sampleMedia().png);
    if (req.headers.authorization !== `Key ${creds}`) return json(res, 401, { detail: 'Invalid credentials' });
    const st = /^\/requests\/([\w-]+)\/status$/.exec(u.pathname);
    if (st) {
      const r = reqs.get(st[1]);
      if (!r) return json(res, 404, { detail: 'Request not found' });
      r.polls++;
      if (r.polls < 2) return json(res, 200, { status: 'in_progress', request_id: st[1] });
      if (r.nsfw) return json(res, 200, { status: 'nsfw', request_id: st[1] });
      return json(res, 200, { status: 'completed', request_id: st[1], ...(r.video ? { video: { url: `${fake.url}/cdn/v.mp4` } } : { images: [{ url: `${fake.url}/cdn/i.png` }] }) });
    }
    if (req.method === 'POST') {
      if (typeof body?.prompt !== 'string') return json(res, 422, { detail: [{ msg: 'prompt required' }] });
      const id = randomUUID();
      reqs.set(id, { polls: 0, video: /video/.test(u.pathname), nsfw: /nsfw/.test(body.prompt) });
      return json(res, 200, { status: 'queued', request_id: id, status_url: `${fake.url}/requests/${id}/status`, cancel_url: `${fake.url}/requests/${id}/cancel` });
    }
    json(res, 404, { detail: 'Not found' });
  });
}

// ── Higgsfield MCP (real MCP protocol via the official SDK) ─────────────────
export function fakeHiggsfieldMcp(token = 'mcp-test-token') {
  const jobs = new Map<string, { polls: number; kind: 'image' | 'video' }>();
  let cdn = '';
  const makeServer = () => {
    const s = new Server({ name: 'fake-higgsfield', version: '1.0.0' }, { capabilities: { tools: {} } });
    const tool = (name: string) => ({ name, inputSchema: { type: 'object' as const, properties: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['models_explore', 'generate_image', 'generate_video', 'jobs_wait'].map(tool) }));
    s.setRequestHandler(CallToolRequestSchema, async (r) => {
      const a = (r.params.arguments ?? {}) as any;
      const out = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
      if (r.params.name === 'models_explore') {
        return out(a.type === 'video'
          ? { items: [{ id: 'seedance_2_5', name: 'Seedance 2.5', output_type: 'video', parameters: [{ name: 'duration', type: 'number', min: 4, max: 30, default: 5 }] }], has_more: false }
          : { items: [{ id: 'gpt_image_2_5', name: 'GPT Image 2.5', output_type: 'image', parameters: [] }], has_more: false });
      }
      if (r.params.name === 'generate_image' || r.params.name === 'generate_video') {
        const p = a.params ?? {};
        if (!p.model || !p.prompt || p.use_unlim !== false) return { isError: true, content: [{ type: 'text', text: 'invalid params' }] };
        const id = randomUUID();
        jobs.set(id, { polls: 0, kind: r.params.name === 'generate_video' ? 'video' : 'image' });
        return out({ jobs: [{ index: 0, job_id: id, status: 'queued' }] });
      }
      if (r.params.name === 'jobs_wait') {
        const j = a.jobs?.[0];
        const job = jobs.get(j?.job_id);
        if (!job) return out({ jobs: [{ index: 0, job_id: j?.job_id, status: 'lookup_failed', error: 'Generation not found', retryable: false }], all_terminal: true });
        job.polls++;
        if (job.polls < 2) return out({ jobs: [{ index: 0, job_id: j.job_id, status: 'in_progress' }], all_terminal: false });
        return out({ jobs: [{ index: 0, job_id: j.job_id, status: 'completed', result: { url: `${cdn}/cdn/${job.kind === 'video' ? 'r.mp4' : 'r.png'}`, thumbnail_url: `${cdn}/cdn/thumb.png` } }], all_terminal: true });
      }
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    });
    return s;
  };
  return serve(async (req, res, body, fake) => {
    cdn = fake.url;
    const u = new URL(req.url!, fake.url);
    if (u.pathname.startsWith('/cdn/')) return res.writeHead(200).end(u.pathname.endsWith('.mp4') ? sampleMedia().mp4 : sampleMedia().png);
    // ── Minimal OAuth 2.1 authorization server (RFC 9728 / 8414 / 7591 + PKCE) ──
    if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(res, 200, { resource: `${fake.url}/mcp`, authorization_servers: [fake.url] });
    if (u.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, 200, { issuer: fake.url, authorization_endpoint: `${fake.url}/authorize`, token_endpoint: `${fake.url}/token`, registration_endpoint: `${fake.url}/register`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    }
    if (u.pathname === '/register' && req.method === 'POST') return json(res, 201, { ...body, client_id: 'fake-client', client_id_issued_at: Math.floor(Date.now() / 1000) });
    if (u.pathname === '/authorize') {
      if (u.searchParams.get('code_challenge_method') !== 'S256' || !u.searchParams.get('code_challenge')) return json(res, 400, { error: 'pkce_required' });
      const redirect = new URL(u.searchParams.get('redirect_uri')!);
      redirect.searchParams.set('code', 'auth-code-1');
      redirect.searchParams.set('state', u.searchParams.get('state') ?? '');
      return res.writeHead(302, { Location: redirect.toString() }).end();
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(typeof body === 'string' ? body : '');
      if (form.get('grant_type') === 'authorization_code' && form.get('code') === 'auth-code-1' && form.get('code_verifier')) {
        return json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1' });
      }
      return json(res, 400, { error: 'invalid_grant' });
    }
    if (u.pathname !== '/mcp') return json(res, 404, {});
    if (req.headers.authorization !== `Bearer ${token}`) {
      return res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${fake.url}/.well-known/oauth-protected-resource/mcp"`, 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_token' }));
    }
    if (req.method !== 'POST') return res.writeHead(405).end();
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
}
