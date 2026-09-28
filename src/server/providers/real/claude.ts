/**
 * Claude (Anthropic) as the AI Director: script writing, script analysis and
 * visual planning. Uses the official @anthropic-ai/sdk. Output is still parsed
 * and validated by our strict zod schemas (runStructured) before use.
 * Defaults: claude-opus-5, adaptive thinking, server-side refusal fallback ("default").
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ConnectionModel } from '../../db/schema';
import { AppError } from '../../errors';
import type { ConnectionSpec, GenerationRequest, LlmProvider, LlmRequest, LlmResponse, PollResult } from '../types';
import { RealProvider, type TestResult } from './base';

interface Secret { apiKey: string }

/** USD per million tokens (input, output) — Anthropic list prices. */
const PRICES: Record<string, [number, number]> = {
  'claude-opus-5': [5, 25], 'claude-sonnet-5': [2, 10], 'claude-haiku-4-5': [1, 5], 'claude-fable-5-1': [10, 50], 'claude-opus-4-8': [5, 25],
};
const SUPPORTS_DEFAULT_FALLBACK = new Set(['claude-opus-5', 'claude-fable-5-1']);

export class ClaudeProvider extends RealProvider {
  id = 'anthropic';
  displayName = 'Claude (AI Director)';
  transport = 'api' as const;
  capabilities = [] as RealProvider['capabilities'];
  defaultBaseUrl = 'https://api.anthropic.com';
  notes = 'Writes scripts, analyses your script, and plans every scene: generation method, prompts, camera and mood.';
  connection: ConnectionSpec = {
    method: 'api_key',
    summary: 'Paste an Anthropic API key. Claude becomes the AI Director that writes scripts and scene prompts. The enabled model is used (Claude Opus 5 recommended).',
    consoleUrl: 'https://platform.claude.com/settings/keys',
    docsUrl: 'https://platform.claude.com/docs',
    fields: [{ key: 'apiKey', label: 'Anthropic API key', secret: true, placeholder: 'sk-ant-…' }],
  };

  private client(apiKey = this.secret<Secret>().apiKey) {
    return new Anthropic({ apiKey, baseURL: this.baseUrl, maxRetries: 2, timeout: 10 * 60 * 1000 });
  }

  parseCredentials(f: Record<string, string>) {
    const apiKey = (f.apiKey ?? '').trim();
    if (apiKey.length < 20) throw new AppError('VALIDATION_ERROR', 'Enter your Anthropic API key.');
    return { secret: { apiKey } satisfies Secret, hint: `…${apiKey.slice(-4)}` };
  }

  async test(secret: unknown, config: Record<string, unknown>): Promise<TestResult> {
    const base = (typeof config.baseUrl === 'string' && config.baseUrl) || this.defaultBaseUrl;
    const client = new Anthropic({ apiKey: (secret as Secret).apiKey, baseURL: base, maxRetries: 1, timeout: 30_000 });
    const ids: string[] = [];
    try {
      for await (const m of client.models.list()) ids.push(m.id);
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new AppError('PROVIDER_NOT_AVAILABLE', 'Anthropic rejected the API key.', { retryable: false });
      throw new AppError('PROVIDER_ERROR', `Could not reach Anthropic: ${(e as Error).message}`, { retryable: true });
    }
    const preferred = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
    const available = preferred.filter((p) => ids.includes(p));
    const list = available.length ? available : ids.filter((i) => i.startsWith('claude-')).slice(0, 5);
    const models: ConnectionModel[] = list.map((id, i) => ({ id, capability: 'llm', label: id, enabled: i === 0, unitCostUsd: null, unit: '1k_tokens', source: 'discovered', notes: PRICES[id] ? `$${PRICES[id][0]} / $${PRICES[id][1]} per M tokens (in/out)` : undefined }));
    return { models, message: `Key accepted. Claude will direct scripts and visual plans using ${list[0] ?? 'the enabled model'}.` };
  }

  get directorModel(): string | null {
    return this.connectionModels.find((m) => m.capability === 'llm' && m.enabled)?.id ?? null;
  }

  llm(): LlmProvider | null {
    if (!this.configStatus().configured || !this.directorModel) return null;
    const model = this.directorModel;
    const client = this.client();
    return {
      id: 'anthropic', model, simulated: false, unitCostPer1kTokensUsd: (PRICES[model]?.[1] ?? 25) / 1000,
      async complete(req: LlmRequest): Promise<LlmResponse> {
        const user = req.repairErrors?.length
          ? `${req.prompt}\n\nYour previous answer was rejected by the validator:\n- ${req.repairErrors.join('\n- ')}\nReturn ONLY the corrected JSON object.`
          : req.prompt;
        let msg;
        try {
          msg = await client.beta.messages.create({
            model,
            max_tokens: 16000,
            system: `${req.system}\nRespond with a single JSON object and nothing else.`,
            messages: [{ role: 'user', content: user }],
            thinking: { type: 'adaptive' },
            ...(SUPPORTS_DEFAULT_FALLBACK.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
          }, { signal: req.signal });
        } catch (e) {
          if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new AppError('PROVIDER_NOT_AVAILABLE', 'Anthropic rejected the API key. Reconnect Claude on the Providers page.', { retryable: false });
          if (e instanceof Anthropic.BadRequestError) throw new AppError('PROVIDER_ERROR', `Claude rejected the request: ${e.message}`, { retryable: false });
          if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError) throw new AppError('PROVIDER_ERROR', `Claude temporarily unavailable: ${e.message}`, { retryable: true });
          throw e;
        }
        if (msg.stop_reason === 'refusal') throw new AppError('PROVIDER_ERROR', `Claude declined this request${msg.stop_details && 'explanation' in msg.stop_details ? `: ${String(msg.stop_details.explanation)}` : ''}. Rephrase the topic or script.`, { retryable: false });
        if (msg.stop_reason === 'max_tokens') throw new AppError('LLM_OUTPUT_INVALID', 'Claude ran out of output tokens; the script may be too long.', { retryable: true });
        const text = msg.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
        const [pin, pout] = PRICES[msg.model] ?? PRICES[model] ?? [5, 25];
        const costUsd = Math.round(((msg.usage.input_tokens * pin + msg.usage.output_tokens * pout) / 1e6) * 10000) / 10000;
        return { text, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, costUsd };
      },
    };
  }

  // Not a media provider.
  async submit(_req: GenerationRequest): Promise<{ externalId: string }> { throw new AppError('PROVIDER_NOT_AVAILABLE', 'Claude is not a media provider', { retryable: false }); }
  async poll(): Promise<PollResult> { throw new AppError('PROVIDER_NOT_AVAILABLE', 'Claude is not a media provider', { retryable: false }); }
}
