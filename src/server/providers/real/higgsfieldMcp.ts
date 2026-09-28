/**
 * Higgsfield via its official MCP server (https://mcp.higgsfield.ai/mcp, streamable HTTP, OAuth).
 * Uses the official @modelcontextprotocol/sdk client — no browser automation.
 * Tool contracts (read from the live server's tool schemas):
 *   models_explore {action:'list', type:'image'|'video', input:'text', limit, after} → {items[]{id,name,parameters[],aspect_ratios[]}, has_more, next_page_token?}
 *   generate_image / generate_video {params:{model, prompt, aspect_ratio, duration?, count, use_unlim:false}} → job id(s)
 *   jobs_wait {jobs:[{index, job_id}], timeout_seconds} → {jobs[]{index, job_id, status, …result URLs}, all_terminal}
 * OAuth: dynamic client registration + PKCE via the SDK; tokens are stored encrypted in provider_connections.
 */
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { config as appConfig } from '../../config';
import { getDb } from '../../db/client';
import type { ConnectionModel } from '../../db/schema';
import { AppError } from '../../errors';
import { getConnection, loadConnection, upsertConnection } from '../connections';
import type { ConnectionSpec, GenerationRequest, PollResult, ProviderContext } from '../types';
import { RealProvider, type TestResult } from './base';
import { aspectFrom } from './http';

export interface McpSecret {
  bearerToken?: string;
  oauth?: { clientInformation?: OAuthClientInformationMixed; tokens?: OAuthTokens; codeVerifier?: string; state?: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function oauthRedirectUrl(): string {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '') || `http://${appConfig.host === '0.0.0.0' ? '127.0.0.1' : appConfig.host}:${appConfig.port}`;
  return `${base}/api/connections/oauth/callback`;
}

/** OAuthClientProvider persisted in the (encrypted) connection secret. */
export class DbOAuthProvider implements OAuthClientProvider {
  authorizationUrl: string | null = null;
  constructor(private providerId: string, private secretState: McpSecret) {}
  private async persist() { await upsertConnection(getDb(), this.providerId, { secret: this.secretState }); }
  private get o() { return (this.secretState.oauth ??= {}); }
  get redirectUrl() { return oauthRedirectUrl(); }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'AF6 Studio', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  async state() { this.o.state = `${this.providerId}.${randomBytes(16).toString('hex')}`; await this.persist(); return this.o.state; }
  clientInformation() { return this.o.clientInformation; }
  async saveClientInformation(info: OAuthClientInformationMixed) { this.o.clientInformation = info; await this.persist(); }
  tokens() { return this.o.tokens; }
  async saveTokens(tokens: OAuthTokens) { this.o.tokens = tokens; await this.persist(); }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url.toString(); }
  async saveCodeVerifier(v: string) { this.o.codeVerifier = v; await this.persist(); }
  codeVerifier() {
    if (!this.o.codeVerifier) throw new Error('No PKCE code verifier saved — restart the connection');
    return this.o.codeVerifier;
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'client') delete this.o.clientInformation;
    if (scope === 'all' || scope === 'tokens') delete this.o.tokens;
    if (scope === 'all' || scope === 'verifier') delete this.o.codeVerifier;
    await this.persist();
  }
}

/** Parse an MCP tool result into JSON (structuredContent first, then JSON text blocks). */
export function toolJson(result: { structuredContent?: unknown; content?: unknown; isError?: boolean }): Record<string, unknown> {
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent as Record<string, unknown>;
  const blocks = Array.isArray(result.content) ? (result.content as { type: string; text?: string }[]) : [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text) { try { const j = JSON.parse(b.text); if (j && typeof j === 'object') return j; } catch { /* not JSON */ } }
  }
  return { text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n') };
}

function findJobId(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  if (Array.isArray(v)) { for (const x of v) { const r = findJobId(x); if (r) return r; } return null; }
  const o = v as Record<string, unknown>;
  for (const k of ['job_id', 'jobId']) if (typeof o[k] === 'string' && UUID.test(o[k] as string)) return o[k] as string;
  for (const k of ['jobs', 'job', 'results', 'generations', 'data']) { const r = findJobId(o[k]); if (r) return r; }
  if (typeof o.id === 'string' && UUID.test(o.id)) return o.id;
  return null;
}

export function findMediaUrl(v: unknown, kind: 'image' | 'video'): string | null {
  const urls: { url: string; key: string }[] = [];
  const walk = (x: unknown, key: string) => {
    if (typeof x === 'string' && (/^https:\/\//.test(x) || (appConfig.isTest && /^http:\/\/127\.0\.0\.1[:/]/.test(x)))) urls.push({ url: x, key });
    else if (Array.isArray(x)) x.forEach((y) => walk(y, key));
    else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) walk(y, k);
  };
  walk(v, '');
  const ext = kind === 'video' ? /\.(mp4|mov|webm)(\?|$)/i : /\.(png|jpe?g|webp)(\?|$)/i;
  return (urls.find((u) => ext.test(u.url)) ?? urls.find((u) => /url|result|output|raw/i.test(u.key) && !/thumb|preview|min/i.test(u.key)) ?? urls[0])?.url ?? null;
}

function durationsFrom(params: { name: string; min?: number; max?: number; options?: unknown[] }[] | undefined): number[] | undefined {
  const d = params?.find((p) => p.name === 'duration');
  if (!d) return undefined;
  if (Array.isArray(d.options)) return d.options.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (d.min != null && d.max != null) { const out: number[] = []; for (let i = Math.ceil(d.min); i <= Math.min(d.max, 60); i++) out.push(i); return out; }
  return undefined;
}

export class HiggsfieldMcpProvider extends RealProvider {
  id = 'higgsfield-mcp';
  displayName = 'Higgsfield MCP';
  transport = 'mcp' as const;
  capabilities = ['image', 'video'] as RealProvider['capabilities'];
  defaultBaseUrl = 'https://mcp.higgsfield.ai/mcp';
  notes = 'Higgsfield model catalog (Seedance, Kling, Veo, GPT Image, Soul, …) through the official MCP server. Sign in once with OAuth.';
  connection: ConnectionSpec = {
    method: 'mcp_oauth',
    summary: 'Connect with your Higgsfield account (OAuth sign-in in a new tab). Generations use your Higgsfield credits; unlimited/free-trial allowances are never used automatically.',
    docsUrl: 'https://higgsfield.ai/creator-hub/help-center/integrations/what-is-higgsfield-mcp',
    fields: [
      { key: 'serverUrl', label: 'MCP server URL', secret: false, placeholder: 'https://mcp.higgsfield.ai/mcp', optional: true },
      { key: 'bearerToken', label: 'Access token (only if not using OAuth)', secret: true, optional: true, help: 'Leave empty to sign in with OAuth.' },
    ],
  };

  private client: Client | null = null;
  private clientKey = '';

  parseCredentials(f: Record<string, string>) {
    const serverUrl = (f.serverUrl ?? '').trim() || this.defaultBaseUrl;
    let u: URL;
    try { u = new URL(serverUrl); } catch { throw new AppError('VALIDATION_ERROR', 'Enter a valid MCP server URL.'); }
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw new AppError('VALIDATION_ERROR', 'MCP server URL must use https.');
    const bearerToken = (f.bearerToken ?? '').trim() || undefined;
    return { secret: { bearerToken } satisfies McpSecret, hint: bearerToken ? `token …${bearerToken.slice(-4)}` : 'OAuth', config: { baseUrl: u.toString() } };
  }

  /** Open an MCP session. Returns the authorization URL instead when the user must sign in. */
  async openSession(secret: McpSecret, serverUrl: string): Promise<{ client?: Client; authorizationUrl?: string }> {
    const oauth = secret.bearerToken ? undefined : new DbOAuthProvider(this.id, secret);
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
      authProvider: oauth,
      requestInit: secret.bearerToken ? { headers: { Authorization: `Bearer ${secret.bearerToken}` } } : undefined,
    });
    const client = new Client({ name: 'af6-studio', version: '0.2.0' });
    try {
      await client.connect(transport);
      return { client };
    } catch (e) {
      if (e instanceof UnauthorizedError && oauth?.authorizationUrl) return { authorizationUrl: oauth.authorizationUrl };
      if (e instanceof UnauthorizedError) throw new AppError('PROVIDER_NOT_AVAILABLE', 'The MCP server rejected the credentials. Reconnect it on the Providers page.', { retryable: false });
      throw new AppError('PROVIDER_ERROR', `Could not reach MCP server: ${(e as Error).message}`, { retryable: true });
    }
  }

  /** Complete OAuth after the redirect: exchange the code for tokens. */
  async finishAuthorization(code: string): Promise<void> {
    const { row, secret } = await loadConnection(getDb(), this.id);
    if (!row) throw new AppError('NOT_FOUND', 'No pending Higgsfield MCP connection');
    const serverUrl = (row.config.baseUrl as string) || this.defaultBaseUrl;
    const oauth = new DbOAuthProvider(this.id, (secret ?? {}) as McpSecret);
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: oauth });
    await transport.finishAuth(code);
  }

  private async session(): Promise<Client> {
    const row = getConnection(this.id);
    const key = `${row?.updatedAt?.getTime() ?? 0}`;
    if (this.client && this.clientKey === key) return this.client;
    await this.client?.close().catch(() => undefined);
    this.client = null;
    const { secret } = await loadConnection(getDb(), this.id);
    if (!secret) throw new AppError('PROVIDER_NOT_AVAILABLE', 'Higgsfield MCP is not connected.', { retryable: false });
    const s = await this.openSession(secret as McpSecret, this.baseUrl);
    if (!s.client) {
      await upsertConnection(getDb(), this.id, { status: 'authorization_required', lastError: 'Sign-in expired — reconnect Higgsfield MCP on the Providers page.' });
      throw new AppError('PROVIDER_NOT_AVAILABLE', 'Higgsfield MCP sign-in expired. Reconnect it on the Providers page.', { retryable: false });
    }
    this.client = s.client;
    this.clientKey = key;
    return s.client;
  }

  private async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    let client = await this.session();
    let res;
    try {
      res = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120_000 });
    } catch (e) {
      // One reconnect on a dropped session.
      this.client = null;
      client = await this.session();
      try { res = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120_000 }); }
      catch (e2) { throw new AppError('PROVIDER_ERROR', `Higgsfield MCP ${name} failed: ${(e2 as Error).message || (e as Error).message}`, { retryable: true }); }
    }
    const json = toolJson(res as never);
    if ((res as { isError?: boolean }).isError) {
      const msg = String(json.text ?? json.error ?? JSON.stringify(json)).slice(0, 500);
      throw new AppError('PROVIDER_ERROR', `Higgsfield MCP ${name}: ${msg}`, { retryable: !/credit|balance|invalid|not found|unsupported/i.test(msg) });
    }
    return json;
  }

  async listModels(client: Client): Promise<ConnectionModel[]> {
    const out: ConnectionModel[] = [];
    for (const type of ['video', 'image'] as const) {
      let after: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = toolJson(await client.callTool({ name: 'models_explore', arguments: { action: 'list', type, input: 'text', limit: 100, ...(after ? { after } : {}) } }) as never);
        const items = (res.items as { id: string; name?: string; description?: string; parameters?: { name: string; min?: number; max?: number; options?: unknown[] }[] }[] | undefined) ?? [];
        for (const it of items) {
          out.push({
            id: it.id, capability: type, label: it.name ?? it.id, enabled: false, unitCostUsd: null, unit: type === 'video' ? 'second' : 'image', source: 'discovered',
            durations: type === 'video' ? durationsFrom(it.parameters) ?? [5] : undefined, notes: it.description?.slice(0, 200),
          });
        }
        after = typeof res.next_page_token === 'string' ? res.next_page_token : undefined;
        if (!res.has_more || !after) break;
      }
    }
    return out;
  }

  async test(secret: unknown, config: Record<string, unknown>): Promise<TestResult> {
    const serverUrl = (typeof config.baseUrl === 'string' && config.baseUrl) || this.defaultBaseUrl;
    const s = await this.openSession(secret as McpSecret, serverUrl);
    if (!s.client) throw new AppError('PROVIDER_NOT_AVAILABLE', 'Sign-in required', { details: { authorizationUrl: s.authorizationUrl } });
    try {
      const tools = await s.client.listTools();
      const names = new Set(tools.tools.map((t) => t.name));
      const missing = ['generate_image', 'generate_video', 'jobs_wait', 'models_explore'].filter((n) => !names.has(n));
      if (missing.length) throw new AppError('PROVIDER_ERROR', `This MCP server does not expose the Higgsfield tools (${missing.join(', ')}).`, { retryable: false });
      const models = await this.listModels(s.client);
      return { models, message: `Connected. ${models.length} text-to-image/video models available — enable the ones you want and set a price per unit (credits → USD).` };
    } finally {
      await s.client.close().catch(() => undefined);
    }
  }

  async submit(req: GenerationRequest, ctx: ProviderContext): Promise<{ externalId: string }> {
    const tool = req.capability === 'video' ? 'generate_video' : req.capability === 'image' ? 'generate_image' : null;
    if (!tool) throw new AppError('PROVIDER_NOT_AVAILABLE', `Higgsfield MCP adapter does not support ${req.capability}`, { retryable: false });
    const params: Record<string, unknown> = {
      model: req.model, prompt: this.promptWithNegative(req), aspect_ratio: aspectFrom(req.width, req.height), count: 1,
      use_unlim: false, // never spend the user's unlimited/free-trial allowance implicitly
      ...(req.capability === 'video' ? { duration: this.requestDuration(req) } : {}),
      ...(this.model(req).extraInput ?? {}),
    };
    const res = await this.call(tool, { params }, ctx.signal);
    if (res.recovery_tool || res.unlim_choice) {
      throw new AppError('PROVIDER_ERROR', `Higgsfield needs attention before generating (${res.recovery_tool ? `recovery: ${String(res.recovery_tool)}` : 'unlimited-allowance choice'}). Resolve it in Higgsfield, then retry.`, { retryable: false });
    }
    const jobId = findJobId(res);
    if (!jobId) throw new AppError('PROVIDER_ERROR', `Higgsfield MCP did not return a job id: ${JSON.stringify(res).slice(0, 300)}`, { retryable: false });
    return { externalId: `${req.capability}:${jobId}` };
  }

  async poll(externalId: string, ctx: ProviderContext): Promise<PollResult> {
    const [kind, jobId] = externalId.split(':') as ['image' | 'video', string];
    const res = await this.call('jobs_wait', { jobs: [{ index: 0, job_id: jobId }], timeout_seconds: 0 }, ctx.signal);
    const job = (res.jobs as Record<string, unknown>[] | undefined)?.[0];
    if (!job) return { status: 'running', progress: 0.3, message: 'Higgsfield: waiting' };
    const status = String(job.status ?? '').toLowerCase();
    if (['completed', 'succeeded', 'success', 'done'].includes(status)) {
      const url = findMediaUrl(job, kind);
      if (!url) return { status: 'failed', progress: 1, error: 'Higgsfield job completed but no media URL was returned', retryable: true };
      const ext = kind === 'video' ? 'mp4' : /\.jpe?g(\?|$)/i.test(url) ? 'jpg' : /\.webp(\?|$)/i.test(url) ? 'webp' : 'png';
      return { status: 'succeeded', progress: 1, output: { kind: 'url', url, ext, mime: kind === 'video' ? 'video/mp4' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}` } };
    }
    if (['failed', 'error', 'nsfw', 'canceled', 'cancelled', 'lookup_failed'].includes(status)) {
      return { status: 'failed', progress: 1, error: `Higgsfield job ${status}${job.error ? `: ${String(job.error)}` : ''}`, retryable: status === 'failed' || (status === 'lookup_failed' && job.retryable === true) };
    }
    return { status: status === 'queued' || status === 'pending' ? 'queued' : 'running', progress: 0.5, message: `Higgsfield: ${status || 'in progress'}` };
  }
}
