/**
 * Base class for real (credentialed) providers. Credentials and the enabled
 * model list come from the user's connection (Providers page), not from code.
 */
import type { Capability } from '../../../shared/schemas';
import type { ConnectionModel } from '../../db/schema';
import { AppError } from '../../errors';
import { getConnection, getSecret } from '../connections';
import type { ConnectionSpec, CostEstimate, GenerationProvider, GenerationRequest, ModelInfo, PollResult, ProviderContext } from '../types';
import { pickDuration } from './http';

export interface TestResult { message: string; models: ConnectionModel[]; config?: Record<string, unknown> }

export abstract class RealProvider implements GenerationProvider {
  abstract id: string;
  abstract displayName: string;
  abstract transport: 'api' | 'mcp';
  abstract capabilities: Capability[];
  abstract connection: ConnectionSpec;
  abstract defaultBaseUrl: string;
  implemented = true;
  requiredEnv: string[] = [];
  notes = '';

  get baseUrl(): string {
    const v = getConnection(this.id)?.config.baseUrl;
    return (typeof v === 'string' && v ? v : this.defaultBaseUrl).replace(/\/+$/, '');
  }

  get connectionModels(): ConnectionModel[] {
    return getConnection(this.id)?.models ?? [];
  }

  get models(): ModelInfo[] {
    return this.connectionModels.filter((m) => m.enabled).map((m) => ({
      id: m.id, capability: m.capability, label: m.label, description: m.notes ?? '', unit: m.unit, unitCostUsd: m.unitCostUsd,
      durations: m.durations, maxDurationSec: m.durations?.length ? Math.max(...m.durations) : undefined,
    }));
  }

  configStatus() {
    const c = getConnection(this.id);
    return c?.status === 'connected' ? { configured: true, missingEnv: [] } : { configured: false, missingEnv: ['connection (Providers page)'] };
  }

  protected secret<T>(): T {
    const s = getSecret<T>(this.id);
    if (!s) throw new AppError('PROVIDER_NOT_AVAILABLE', `${this.displayName} is not connected. Connect it on the Providers page.`, { retryable: false });
    return s;
  }

  protected model(req: GenerationRequest): ConnectionModel {
    const m = this.connectionModels.find((x) => x.id === req.model && x.capability === req.capability);
    if (!m) throw new AppError('PROVIDER_NOT_AVAILABLE', `${this.displayName} model "${req.model}" is not enabled for ${req.capability}.`, { retryable: false });
    return m;
  }

  /** Output length requested from the provider for a video request. */
  requestDuration(req: GenerationRequest): number {
    return pickDuration(this.model(req).durations, req.durationSec ?? 5);
  }

  estimateCost(req: GenerationRequest): CostEstimate {
    const m = this.model(req);
    if (m.unitCostUsd == null) {
      throw new AppError('PROVIDER_NOT_AVAILABLE', `Set a price for ${this.displayName} · ${m.label} on the Providers page before generating (the budget guard needs it).`, { retryable: false });
    }
    const units = m.unit === 'second' ? this.requestDuration(req) : 1;
    return { units, unit: m.unit, unitCostUsd: m.unitCostUsd, amountUsd: Math.round(units * m.unitCostUsd * 10000) / 10000, simulated: false };
  }

  /** Negative prompts are folded into the prompt for APIs without a dedicated field. */
  protected promptWithNegative(req: GenerationRequest): string {
    return req.negativePrompt ? `${req.prompt}\nAvoid: ${req.negativePrompt}` : req.prompt;
  }

  /** Turn the fields the user typed into a secret (never returned to the browser) + a display hint. */
  abstract parseCredentials(fields: Record<string, string>): { secret: unknown; hint: string; config?: Record<string, unknown> };
  /** Validate credentials against the provider and return the model catalog to offer. */
  abstract test(secret: unknown, config: Record<string, unknown>, signal?: AbortSignal): Promise<TestResult>;
  abstract submit(req: GenerationRequest, ctx: ProviderContext): Promise<{ externalId: string }>;
  abstract poll(externalId: string, ctx: ProviderContext): Promise<PollResult>;
}
