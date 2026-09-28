import type { Capability, WordTiming } from '../../shared/schemas';

export type PricingUnit = 'image' | 'second' | '1k_chars' | '1k_tokens';

export interface ModelInfo {
  id: string;
  capability: Capability;
  label: string;
  description: string;
  unit: PricingUnit;
  unitCostUsd: number;
  maxDurationSec?: number;
  /** Mock only: multiplies simulated latency. */
  speedFactor?: number;
}

export interface VoiceInfo { id: string; label: string; description: string; basePitch: number; rateFactor: number }

export interface GenerationRequest {
  capability: Capability;
  model: string;
  prompt: string;
  negativePrompt?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  seed?: number;
  references?: string[];
  /** TTS */
  text?: string;
  voiceId?: string;
  wordsPerMinute?: number;
  /** Human label (e.g. "Scene 3") — used by mock rendering only. */
  label?: string;
}

export interface CostEstimate { units: number; unit: PricingUnit; unitCostUsd: number; amountUsd: number; simulated: boolean }

export type ProviderOutput =
  | { kind: 'file'; path: string; mime: string; ext: string; words?: WordTiming[]; metadata?: Record<string, unknown> }
  | { kind: 'url'; url: string; mime: string; ext: string; words?: WordTiming[]; metadata?: Record<string, unknown> };

export interface PollResult {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress: number;
  message?: string;
  error?: string;
  /** Whether a failed task is worth resubmitting (capacity) vs not (moderation). */
  retryable?: boolean;
  output?: ProviderOutput;
  actualCost?: CostEstimate;
}

export interface ProviderContext { signal?: AbortSignal }

export interface GenerationProvider {
  id: string;
  displayName: string;
  transport: 'mock' | 'api' | 'mcp';
  /** False = adapter architecture only; cannot be used until implemented against official docs. */
  implemented: boolean;
  docsUrl?: string;
  capabilities: Capability[];
  requiredEnv: string[];
  models: ModelInfo[];
  voices?: VoiceInfo[];
  configStatus(): { configured: boolean; missingEnv: string[] };
  estimateCost(req: GenerationRequest): CostEstimate;
  submit(req: GenerationRequest, ctx: ProviderContext): Promise<{ externalId: string }>;
  poll(externalId: string, ctx: ProviderContext): Promise<PollResult>;
  cancel?(externalId: string): Promise<void>;
}

// ── LLM ──────────────────────────────────────────────────────────────────────

export type LlmTask = 'script.generate' | 'script.analyze' | 'visuals.plan';

export interface LlmRequest {
  task: LlmTask;
  system: string;
  prompt: string;
  /** Structured context. Real adapters rely on `prompt`; the mock adapter reads this. */
  context: Record<string, unknown>;
  /** Present on a repair round: validation errors from the previous attempt. */
  repairErrors?: string[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmResponse { text: string; inputTokens: number; outputTokens: number }

export interface LlmProvider {
  id: string;
  model: string;
  simulated: boolean;
  unitCostPer1kTokensUsd: number;
  complete(req: LlmRequest): Promise<LlmResponse>;
}
