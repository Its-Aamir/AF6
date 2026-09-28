/**
 * Higgsfield platform API. Built against the official SDK @higgsfield/client v2
 * (github.com/higgsfield-ai/higgsfield-js, npm 0.2.6):
 *   Auth:    Authorization: Key KEY_ID:KEY_SECRET   (server-side only)
 *   Submit:  POST https://api.higgsfield.ai/{endpoint}   body = the endpoint's input object
 *            → {request_id, status, status_url, cancel_url}
 *   Status:  GET /requests/{request_id}/status → status: queued | in_progress | completed | failed | nsfw
 *            completed → images[].url (image endpoints) or video.url (video endpoints)
 *   Errors:  401 bad credentials, 403 not enough credits, 400/422 bad input.
 * Higgsfield models are addressed by endpoint path (e.g. "flux-pro/kontext/max/text-to-image"),
 * so the user adds the endpoints they want; per-endpoint extra input is configurable.
 */
import type { ConnectionModel } from '../../db/schema';
import { AppError } from '../../errors';
import type { ConnectionSpec, GenerationRequest, PollResult, ProviderContext } from '../types';
import { RealProvider, type TestResult } from './base';
import { aspectFrom, httpJson } from './http';

interface Secret { credentials: string }
interface StatusResponse { status?: string; request_id?: string; images?: { url: string }[]; video?: { url: string }; detail?: unknown; error?: string }

export const HIGGSFIELD_API_CATALOG: ConnectionModel[] = [
  { id: 'flux-pro/kontext/max/text-to-image', capability: 'image', label: 'FLUX.1 Kontext Max (text-to-image)', enabled: true, unitCostUsd: null, unit: 'image', source: 'catalog', notes: 'Endpoint from the official SDK README. Set your price per image.' },
];

export class HiggsfieldApiProvider extends RealProvider {
  id = 'higgsfield-api';
  displayName = 'Higgsfield API';
  transport = 'api' as const;
  capabilities = ['image', 'video'] as RealProvider['capabilities'];
  defaultBaseUrl = 'https://api.higgsfield.ai';
  notes = 'Any Higgsfield endpoint you add (images or text-to-video). Uses KEY_ID:KEY_SECRET credentials.';
  connection: ConnectionSpec = {
    method: 'api_key',
    summary: 'Create a server-side credential in the Higgsfield console and paste the key ID and secret. Then add the model endpoints you want to use.',
    consoleUrl: 'https://cloud.higgsfield.ai',
    docsUrl: 'https://docs.higgsfield.ai',
    fields: [
      { key: 'keyId', label: 'API key ID', secret: false },
      { key: 'keySecret', label: 'API key secret', secret: true },
    ],
  };

  private headers(creds = this.secret<Secret>().credentials) { return { Authorization: `Key ${creds}` }; }

  private fail(where: string, status: number, body: StatusResponse | null, text: string): never {
    const msg = typeof body?.detail === 'string' ? body.detail : body?.detail ? JSON.stringify(body.detail).slice(0, 300) : text.slice(0, 300);
    if (status === 401) throw new AppError('PROVIDER_NOT_AVAILABLE', 'Higgsfield rejected the credentials (401). Reconnect it on the Providers page.', { retryable: false });
    if (status === 403) throw new AppError('PROVIDER_ERROR', 'Higgsfield: not enough credits (403).', { retryable: false });
    if (status === 400 || status === 422) throw new AppError('PROVIDER_ERROR', `Higgsfield rejected the input (${status}): ${msg}. Check this endpoint's extra input on the Providers page.`, { retryable: false });
    throw new AppError('PROVIDER_ERROR', `Higgsfield ${where} failed (${status}): ${msg}`, { retryable: status === 429 || status >= 500 });
  }

  parseCredentials(f: Record<string, string>) {
    const id = (f.keyId ?? '').trim();
    const secret = (f.keySecret ?? '').trim();
    if (!id || !secret) throw new AppError('VALIDATION_ERROR', 'Enter both the key ID and the key secret.');
    return { secret: { credentials: `${id}:${secret}` } satisfies Secret, hint: `${id.slice(0, 6)}… / …${secret.slice(-4)}` };
  }

  async test(secret: unknown, config: Record<string, unknown>, signal?: AbortSignal): Promise<TestResult> {
    const base = ((typeof config.baseUrl === 'string' && config.baseUrl) || this.defaultBaseUrl).replace(/\/+$/, '');
    // Status lookup of a random id: 401 means bad credentials, anything else means they were accepted.
    const r = await httpJson<StatusResponse>(`${base}/requests/00000000-0000-4000-8000-000000000000/status`, { headers: this.headers((secret as Secret).credentials), signal, timeoutMs: 20_000 });
    if (r.status === 401) this.fail('authentication', r.status, r.json, r.text);
    if (r.status >= 500) this.fail('connection test', r.status, r.json, r.text);
    return { models: HIGGSFIELD_API_CATALOG.map((m) => ({ ...m })), message: 'Credentials accepted. Add the Higgsfield endpoints you want (image or video) and set their prices.' };
  }

  async submit(req: GenerationRequest, ctx: ProviderContext): Promise<{ externalId: string }> {
    const m = this.model(req);
    const endpoint = req.model.replace(/^\/+/, '');
    if (!/^[a-zA-Z0-9][\w./-]*$/.test(endpoint) || endpoint.includes('..')) throw new AppError('VALIDATION_ERROR', `Invalid Higgsfield endpoint "${req.model}"`);
    const body: Record<string, unknown> = {
      prompt: this.promptWithNegative(req),
      aspect_ratio: aspectFrom(req.width, req.height),
      ...(req.capability === 'video' ? { duration: this.requestDuration(req) } : {}),
      ...(m.extraInput ?? {}),
    };
    const r = await httpJson<StatusResponse>(`${this.baseUrl}/${endpoint}`, { headers: this.headers(), body, signal: ctx.signal });
    if (r.status < 200 || r.status >= 300 || !r.json?.request_id) this.fail('submit', r.status, r.json, r.text);
    return { externalId: r.json.request_id! };
  }

  async poll(externalId: string, ctx: ProviderContext): Promise<PollResult> {
    const r = await httpJson<StatusResponse>(`${this.baseUrl}/requests/${encodeURIComponent(externalId)}/status`, { headers: this.headers(), signal: ctx.signal });
    if (r.status !== 200) this.fail('status', r.status, r.json, r.text);
    const s = r.json;
    switch (s.status) {
      case 'completed': {
        if (s.video?.url) return { status: 'succeeded', progress: 1, output: { kind: 'url', url: s.video.url, mime: 'video/mp4', ext: 'mp4' } };
        const img = s.images?.[0]?.url;
        if (img) {
          const ext = /\.(jpe?g)(\?|$)/i.test(img) ? 'jpg' : /\.webp(\?|$)/i.test(img) ? 'webp' : 'png';
          return { status: 'succeeded', progress: 1, output: { kind: 'url', url: img, mime: ext === 'jpg' ? 'image/jpeg' : `image/${ext}`, ext } };
        }
        return { status: 'failed', progress: 1, error: 'Higgsfield completed without an output URL', retryable: true };
      }
      case 'nsfw': return { status: 'failed', progress: 1, error: 'Higgsfield moderation rejected the content (credits refunded). Adjust the prompt.', retryable: false };
      case 'failed': return { status: 'failed', progress: 1, error: `Higgsfield generation failed (credits refunded)${s.error ? `: ${s.error}` : ''}`, retryable: true };
      case 'canceled': return { status: 'failed', progress: 1, error: 'Higgsfield request was cancelled', retryable: false };
      case 'queued': return { status: 'queued', progress: 0.1, message: 'Higgsfield: queued' };
      default: return { status: 'running', progress: 0.5, message: `Higgsfield: ${s.status ?? 'in progress'}` };
    }
  }
}
