/**
 * Kling AI. Built against the official Kling API docs (kling.ai/document-api,
 * snapshot 2026-09-20):
 *   Auth:   Authorization: Bearer <API_KEY>, domain https://api-singapore.klingai.com
 *   Video:  POST /text-to-video/{model} {prompt, settings:{resolution,aspect_ratio,duration}, options:{external_task_id}}
 *           → {code, message, data:{id, status}}
 *           GET  /tasks?task_ids=… | ?external_task_ids=… → data[]{status: submitted|processing|succeeded|failed, message, outputs[]{type,url}}
 *   Image:  POST /v1/images/generations {model_name, prompt, negative_prompt, n, aspect_ratio, resolution, external_task_id}
 *           → data.task_id;  GET /v1/images/generations/{id} → data{task_status: submitted|processing|succeed|failed, task_status_msg, task_result.images[].url}
 *   Errors: envelope `code` (0 = ok). 1000–1004 auth, 1102 no resources, 1301 content policy, 1302/1303 rate/concurrency, 5000–5002 server.
 * `external_task_id` = our idempotency key, so a crash between submit and
 * saving the task id is recovered by querying instead of re-submitting (no double billing).
 */
import type { ConnectionModel } from '../../db/schema';
import { AppError } from '../../errors';
import type { ConnectionSpec, GenerationRequest, PollResult, ProviderContext } from '../types';
import { RealProvider, type TestResult } from './base';
import { aspectFrom, httpJson } from './http';

interface Secret { apiKey: string }
interface Envelope<T> { code?: number; message?: string; request_id?: string; data?: T }
interface VideoTask { id: string; status: 'submitted' | 'processing' | 'succeeded' | 'failed'; message?: string; outputs?: { type: string; url?: string }[] }
interface ImageTask { task_id: string; task_status: 'submitted' | 'processing' | 'succeed' | 'failed'; task_status_msg?: string; task_result?: { images?: { url: string }[] } }

/** Official catalog + pricing (USD, 720p for video) from the 2026-09-20 docs. Users can edit prices. */
export const KLING_CATALOG: ConnectionModel[] = [
  { id: 'kling-3.0-turbo', capability: 'video', label: 'Kling 3.0 Turbo', enabled: true, unitCostUsd: 0.112, unit: 'second', durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], source: 'catalog', notes: 'Best value, native audio. $0.112/s at 720p.' },
  { id: 'kling-3.0', capability: 'video', label: 'Kling 3.0', enabled: true, unitCostUsd: 0.126, unit: 'second', durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], source: 'catalog', notes: 'Priced at the with-audio rate ($0.126/s 720p) to stay conservative.' },
  { id: 'kling-2.6', capability: 'video', label: 'Kling 2.6', enabled: false, unitCostUsd: 0.042, unit: 'second', durations: [5, 10], source: 'catalog', notes: '720p silent. $0.042/s.' },
  { id: 'kling-2.5-turbo', capability: 'video', label: 'Kling 2.5 Turbo', enabled: false, unitCostUsd: 0.042, unit: 'second', durations: [5, 10], source: 'catalog', notes: '$0.042/s at 720p.' },
  { id: 'kling-v3', capability: 'image', label: 'Kling Image 3.0', enabled: true, unitCostUsd: 0.028, unit: 'image', source: 'catalog', notes: '$0.028/image (1K/2K).' },
  { id: 'kling-v2-1', capability: 'image', label: 'Kling Image 2.1', enabled: false, unitCostUsd: 0.014, unit: 'image', source: 'catalog', notes: '$0.014/image text-to-image.' },
];

const NON_RETRYABLE = new Set([1000, 1001, 1002, 1003, 1004, 1100, 1101, 1102, 1103, 1200, 1201, 1202, 1203, 1300, 1301, 1304]);

export class KlingProvider extends RealProvider {
  id = 'kling';
  displayName = 'Kling AI';
  transport = 'api' as const;
  capabilities = ['video', 'image'] as RealProvider['capabilities'];
  defaultBaseUrl = 'https://api-singapore.klingai.com';
  notes = 'Text-to-video (Kling 3.0 / 2.x) and Kling image models.';
  connection: ConnectionSpec = {
    method: 'api_key',
    summary: 'Paste an API key from the Kling developer console (resource packages are billed by Kling).',
    consoleUrl: 'https://kling.ai/dev/api-key',
    docsUrl: 'https://kling.ai/document-api/api/get-started/authentication',
    fields: [{ key: 'apiKey', label: 'Kling API key', secret: true, placeholder: 'Shown once when you create it' }],
  };

  private headers(apiKey = this.secret<Secret>().apiKey) { return { Authorization: `Bearer ${apiKey}` }; }

  private fail(where: string, status: number, env: Envelope<unknown> | null, text: string): never {
    const code = env?.code;
    const msg = env?.message ?? text.slice(0, 200);
    if (status === 401 || (code != null && code >= 1000 && code <= 1004)) {
      throw new AppError('PROVIDER_NOT_AVAILABLE', `Kling rejected the API key (${code ?? status}): ${msg}. Reconnect it on the Providers page.`, { retryable: false });
    }
    const retryable = code != null ? !NON_RETRYABLE.has(code) : status === 429 || status >= 500;
    throw new AppError('PROVIDER_ERROR', `Kling ${where} failed (${code ?? status}): ${msg}`, { retryable });
  }

  parseCredentials(f: Record<string, string>) {
    const apiKey = (f.apiKey ?? '').trim();
    if (apiKey.length < 10) throw new AppError('VALIDATION_ERROR', 'Enter your Kling API key.');
    return { secret: { apiKey } satisfies Secret, hint: `…${apiKey.slice(-4)}` };
  }

  async test(secret: unknown, config: Record<string, unknown>, signal?: AbortSignal): Promise<TestResult> {
    const base = ((typeof config.baseUrl === 'string' && config.baseUrl) || this.defaultBaseUrl).replace(/\/+$/, '');
    // Querying a non-existent task is free; a bad key yields 401 / code 1000-1004.
    const r = await httpJson<Envelope<unknown>>(`${base}/tasks?task_ids=0`, { headers: this.headers((secret as Secret).apiKey), signal, timeoutMs: 20_000 });
    if (r.status === 401 || (r.json?.code != null && r.json.code >= 1000 && r.json.code <= 1004)) this.fail('authentication', r.status, r.json, r.text);
    if (r.status >= 500) this.fail('connection test', r.status, r.json, r.text);
    return { models: KLING_CATALOG.map((m) => ({ ...m })), message: 'API key accepted. Kling models from the official catalog are listed below with official prices.' };
  }

  async submit(req: GenerationRequest, ctx: ProviderContext): Promise<{ externalId: string }> {
    const ext = req.idempotencyKey?.slice(0, 64);
    if (req.capability === 'video') {
      if (ext) {
        // Recover a task created by a previous attempt that crashed before saving its id.
        const existing = await httpJson<Envelope<VideoTask[]>>(`${this.baseUrl}/tasks?external_task_ids=${encodeURIComponent(ext)}`, { headers: this.headers(), signal: ctx.signal });
        const found = existing.status === 200 && existing.json?.code === 0 ? existing.json.data?.[0] : undefined;
        if (found?.id) return { externalId: `video:${found.id}` };
      }
      const aspect = aspectFrom(req.width, req.height);
      const r = await httpJson<Envelope<{ id: string }>>(`${this.baseUrl}/text-to-video/${encodeURIComponent(req.model)}`, {
        headers: this.headers(), signal: ctx.signal,
        body: {
          prompt: this.promptWithNegative(req).slice(0, 2500),
          settings: { resolution: '720p', aspect_ratio: aspect, duration: this.requestDuration(req) },
          options: { ...(ext ? { external_task_id: ext } : {}), watermark_info: { enabled: false } },
        },
      });
      if (r.status !== 200 || r.json?.code !== 0 || !r.json.data?.id) this.fail('video submit', r.status, r.json, r.text);
      return { externalId: `video:${r.json.data!.id}` };
    }
    if (req.capability === 'image') {
      const r = await httpJson<Envelope<{ task_id: string }>>(`${this.baseUrl}/v1/images/generations`, {
        headers: this.headers(), signal: ctx.signal,
        body: {
          model_name: req.model, prompt: req.prompt.slice(0, 2500), negative_prompt: req.negativePrompt ?? '', n: 1,
          aspect_ratio: aspectFrom(req.width, req.height), resolution: '1k', ...(ext ? { external_task_id: ext } : {}),
        },
      });
      if (r.status !== 200 || r.json?.code !== 0 || !r.json.data?.task_id) this.fail('image submit', r.status, r.json, r.text);
      return { externalId: `image:${r.json.data!.task_id}` };
    }
    throw new AppError('PROVIDER_NOT_AVAILABLE', `Kling adapter does not support ${req.capability}`, { retryable: false });
  }

  async poll(externalId: string, ctx: ProviderContext): Promise<PollResult> {
    const [kind, id] = [externalId.slice(0, externalId.indexOf(':')), externalId.slice(externalId.indexOf(':') + 1)];
    if (kind === 'video') {
      const r = await httpJson<Envelope<VideoTask[]>>(`${this.baseUrl}/tasks?task_ids=${encodeURIComponent(id)}`, { headers: this.headers(), signal: ctx.signal });
      if (r.status !== 200 || r.json?.code !== 0) this.fail('status', r.status, r.json, r.text);
      const t = r.json.data?.[0];
      if (!t) return { status: 'queued', progress: 0, message: 'Waiting for Kling to register the task' };
      if (t.status === 'failed') return { status: 'failed', progress: 1, error: `Kling: ${t.message ?? 'generation failed'}`, retryable: !/risk|policy|content/i.test(t.message ?? '') };
      if (t.status !== 'succeeded') return { status: t.status === 'submitted' ? 'queued' : 'running', progress: t.status === 'submitted' ? 0.1 : 0.5, message: `Kling: ${t.status}` };
      const url = t.outputs?.find((o) => o.type === 'video' && o.url)?.url;
      if (!url) return { status: 'failed', progress: 1, error: 'Kling reported success but returned no video URL', retryable: true };
      return { status: 'succeeded', progress: 1, output: { kind: 'url', url, mime: 'video/mp4', ext: 'mp4' } };
    }
    const r = await httpJson<Envelope<ImageTask>>(`${this.baseUrl}/v1/images/generations/${encodeURIComponent(id)}`, { headers: this.headers(), signal: ctx.signal });
    if (r.status !== 200 || r.json?.code !== 0 || !r.json.data) this.fail('status', r.status, r.json, r.text);
    const t = r.json.data!;
    if (t.task_status === 'failed') return { status: 'failed', progress: 1, error: `Kling: ${t.task_status_msg ?? 'generation failed'}`, retryable: !/risk|policy|content/i.test(t.task_status_msg ?? '') };
    if (t.task_status !== 'succeed') return { status: t.task_status === 'submitted' ? 'queued' : 'running', progress: 0.5, message: `Kling: ${t.task_status}` };
    const url = t.task_result?.images?.[0]?.url;
    if (!url) return { status: 'failed', progress: 1, error: 'Kling returned no image URL', retryable: true };
    const ext = /\.(jpe?g)(\?|$)/i.test(url) ? 'jpg' : 'png';
    return { status: 'succeeded', progress: 1, output: { kind: 'url', url, mime: ext === 'jpg' ? 'image/jpeg' : 'image/png', ext } };
  }
}
