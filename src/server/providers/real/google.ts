/**
 * Google Gemini API: Veo (video) and Gemini native image models (image).
 * Request/response shapes follow the official @google/genai SDK (v2.24) mapping
 * for the Gemini Developer API:
 *   video: POST /v1beta/models/{model}:predictLongRunning  {instances:[{prompt}], parameters:{aspectRatio,durationSeconds,resolution,negativePrompt,sampleCount}}
 *          GET  /v1beta/{operation.name} → {done, error, response.generateVideoResponse.generatedSamples[].video.uri}
 *          video.uri is downloaded with the same x-goog-api-key header.
 *   image: POST /v1beta/models/{model}:generateContent {contents, generationConfig:{responseModalities:['IMAGE'], imageConfig:{aspectRatio}}}
 *          → candidates[0].content.parts[].inlineData {mimeType, data(base64)}
 *   models: GET /v1beta/models → supportedGenerationMethods
 * Note: the Gemini Developer API does not accept `seed` for Veo (SDK rejects it), so it is not sent.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { ConnectionModel } from '../../db/schema';
import { AppError } from '../../errors';
import { getStorage } from '../../storage/storage';
import type { ConnectionSpec, GenerationRequest, PollResult, ProviderContext } from '../types';
import { RealProvider, type TestResult } from './base';
import { aspectFrom, httpError, httpJson } from './http';

interface Secret { apiKey: string }
type ApiError = { error?: { code?: number; message?: string; status?: string } };

export class GoogleProvider extends RealProvider {
  id = 'google';
  displayName = 'Google Veo + Gemini';
  transport = 'api' as const;
  capabilities = ['video', 'image'] as RealProvider['capabilities'];
  defaultBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  notes = 'Veo for video, Gemini image models for stills. One API key from Google AI Studio.';
  connection: ConnectionSpec = {
    method: 'api_key',
    summary: 'Paste a Gemini API key. Available Veo and image models are discovered from your key.',
    consoleUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/video',
    fields: [{ key: 'apiKey', label: 'Gemini API key', secret: true, placeholder: 'AIza…' }],
  };

  private headers(): Record<string, string> { return { 'x-goog-api-key': this.secret<Secret>().apiKey }; }

  parseCredentials(f: Record<string, string>) {
    const apiKey = (f.apiKey ?? '').trim();
    if (apiKey.length < 20) throw new AppError('VALIDATION_ERROR', 'That does not look like a Gemini API key.');
    return { secret: { apiKey } satisfies Secret, hint: `…${apiKey.slice(-4)}` };
  }

  async test(secret: unknown, config: Record<string, unknown>, signal?: AbortSignal): Promise<TestResult> {
    const base = (typeof config.baseUrl === 'string' && config.baseUrl) || this.defaultBaseUrl;
    const models: ConnectionModel[] = [];
    let pageToken = '';
    for (let page = 0; page < 10; page++) {
      const r = await httpJson<{ models?: { name: string; displayName?: string; description?: string; supportedGenerationMethods?: string[] }[]; nextPageToken?: string } & ApiError>(
        `${base}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { headers: { 'x-goog-api-key': (secret as Secret).apiKey }, signal, timeoutMs: 20_000 });
      if (r.status !== 200) throw httpError('Google', r.status, r.json?.error?.message ?? r.text.slice(0, 200));
      for (const m of r.json.models ?? []) {
        const id = m.name.replace(/^models\//, '');
        const methods = m.supportedGenerationMethods ?? [];
        if (id.startsWith('veo-') && methods.includes('predictLongRunning')) {
          models.push({ id, capability: 'video', label: m.displayName ?? id, enabled: true, unitCostUsd: null, unit: 'second', source: 'discovered',
            durations: id.startsWith('veo-2') ? [5, 6, 7, 8] : [4, 6, 8], notes: m.description?.slice(0, 200) });
        } else if (/image/.test(id) && id.startsWith('gemini') && methods.includes('generateContent')) {
          models.push({ id, capability: 'image', label: m.displayName ?? id, enabled: true, unitCostUsd: null, unit: 'image', source: 'discovered', notes: m.description?.slice(0, 200) });
        }
      }
      if (!r.json.nextPageToken) break;
      pageToken = r.json.nextPageToken;
    }
    const v = models.filter((m) => m.capability === 'video').length;
    const i = models.filter((m) => m.capability === 'image').length;
    return { models, message: `Key accepted. Found ${v} Veo model(s) and ${i} image model(s). Set a price for each model you enable.` };
  }

  async submit(req: GenerationRequest, ctx: ProviderContext): Promise<{ externalId: string }> {
    const aspect = aspectFrom(req.width, req.height);
    if (req.capability === 'video') {
      const r = await httpJson<{ name?: string } & ApiError>(`${this.baseUrl}/models/${encodeURIComponent(req.model)}:predictLongRunning`, {
        headers: this.headers(), signal: ctx.signal,
        body: {
          instances: [{ prompt: req.prompt }],
          parameters: {
            aspectRatio: aspect === '1:1' ? '16:9' : aspect, // Veo: 16:9 or 9:16; square is cropped at render
            durationSeconds: this.requestDuration(req),
            resolution: '720p',
            sampleCount: 1,
            ...(req.negativePrompt ? { negativePrompt: req.negativePrompt } : {}),
          },
        },
      });
      if (r.status !== 200 || !r.json?.name) throw httpError('Google Veo', r.status, r.json?.error?.message ?? r.text.slice(0, 300));
      return { externalId: `op:${r.json.name}` };
    }
    if (req.capability === 'image') {
      // Synchronous API: persist the result now so polling (and crash recovery) can pick it up.
      const r = await httpJson<{ candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } } & ApiError>(
        `${this.baseUrl}/models/${encodeURIComponent(req.model)}:generateContent`, {
          headers: this.headers(), signal: ctx.signal, timeoutMs: 120_000,
          body: {
            contents: [{ role: 'user', parts: [{ text: this.promptWithNegative(req) }] }],
            generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect } },
          },
        });
      if (r.status !== 200) throw httpError('Google image', r.status, r.json?.error?.message ?? r.text.slice(0, 300));
      const part = r.json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part?.inlineData?.data) {
        const why = r.json.promptFeedback?.blockReason ?? r.json.candidates?.[0]?.finishReason ?? 'no image returned';
        throw new AppError('PROVIDER_ERROR', `Google returned no image (${why}).`, { retryable: why !== 'SAFETY' && why !== 'PROHIBITED_CONTENT' });
      }
      const mime = part.inlineData.mimeType ?? 'image/png';
      const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
      const key = `provider-results/google/${randomUUID()}.${ext}`;
      await getStorage().putBuffer(key, Buffer.from(part.inlineData.data, 'base64'));
      return { externalId: `file:${key}` };
    }
    throw new AppError('PROVIDER_NOT_AVAILABLE', `Google adapter does not support ${req.capability}`, { retryable: false });
  }

  async poll(externalId: string, ctx: ProviderContext): Promise<PollResult> {
    if (externalId.startsWith('file:')) {
      const key = externalId.slice(5);
      const path = getStorage().resolve(key);
      await fs.access(path).catch(() => { throw new AppError('PROVIDER_ERROR', 'Stored provider result is missing; will regenerate.', { retryable: true }); });
      const ext = key.split('.').pop()!;
      return { status: 'succeeded', progress: 1, output: { kind: 'file', path, ext, mime: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` } };
    }
    const name = externalId.replace(/^op:/, '');
    const r = await httpJson<{ done?: boolean; error?: { message?: string; code?: number }; response?: { generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[]; raiMediaFilteredCount?: number; raiMediaFilteredReasons?: string[] } } }>(
      `${this.baseUrl}/${name}`, { headers: this.headers(), signal: ctx.signal, timeoutMs: 20_000 });
    if (r.status !== 200) throw httpError('Google Veo', r.status, r.text.slice(0, 300));
    const op = r.json;
    if (!op.done) return { status: 'running', progress: 0.5, message: 'Veo is generating' };
    if (op.error) return { status: 'failed', progress: 1, error: `Veo: ${op.error.message ?? 'generation failed'}`, retryable: true };
    const res = op.response?.generateVideoResponse;
    const uri = res?.generatedSamples?.[0]?.video?.uri;
    if (!uri) {
      const reasons = res?.raiMediaFilteredReasons?.join('; ');
      return { status: 'failed', progress: 1, error: `Veo returned no video${reasons ? ` (filtered: ${reasons})` : ''}. Adjust the prompt.`, retryable: false };
    }
    return { status: 'succeeded', progress: 1, output: { kind: 'url', url: uri, mime: 'video/mp4', ext: 'mp4', headers: this.headers() } };
  }
}
