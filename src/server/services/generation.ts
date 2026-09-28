/**
 * Provider-agnostic generation driver: submit once, persist the external id,
 * poll on subsequent job runs. Resumable across worker restarts because all
 * state lives in the `generations` row.
 */
import { eq, sql } from 'drizzle-orm';
import type { Capability } from '../../shared/schemas';
import type { Tx } from '../db/client';
import { generations, type GenerationRow } from '../db/schema';
import { AppError } from '../errors';
import type { JobContext } from '../jobs/types';
import { getProvider, resolveModel } from '../providers/registry';
import type { CostEstimate, GenerationRequest, ProviderOutput } from '../providers/types';
import { recordCost } from './costs';
import { getSettings } from './settings';

export async function createGeneration(
  db: Tx,
  g: { projectId: string | null; sceneId?: string | null; request: GenerationRequest; provider: string; estimate: CostEstimate },
): Promise<GenerationRow> {
  const [row] = await db.insert(generations).values({
    projectId: g.projectId, sceneId: g.sceneId ?? null, capability: g.request.capability, provider: g.provider, model: g.request.model,
    prompt: g.request.prompt, params: g.request as unknown as Record<string, unknown>, status: 'pending', estimatedCostUsd: g.estimate.amountUsd,
  }).returning();
  return row;
}

export function estimateFor(capability: Capability, provider: string, request: GenerationRequest): CostEstimate {
  const { provider: p } = resolveModel(capability, provider, request.model);
  return p.estimateCost(request);
}

export type DriveResult =
  | { state: 'waiting'; gen: GenerationRow }
  | { state: 'succeeded'; gen: GenerationRow; output: ProviderOutput; actualCost?: CostEstimate }
  | { state: 'already_done'; gen: GenerationRow };

const POLL_DEFAULT_DEADLINE_MS = 15 * 60_000;

export async function driveGeneration(ctx: JobContext<unknown>, generationId: string): Promise<DriveResult> {
  const { db, signal } = ctx;
  const gen = await db.query.generations.findFirst({ where: eq(generations.id, generationId) });
  if (!gen) throw new AppError('NOT_FOUND', `Generation ${generationId} not found`, { retryable: false });
  if (gen.status === 'succeeded') return { state: 'already_done', gen };
  if (gen.status === 'cancelled') throw new AppError('CANCELLED', 'Generation was cancelled');
  const request = gen.params as unknown as GenerationRequest;
  const { provider } = resolveModel(request.capability, gen.provider, request.model);

  if (!gen.externalId) {
    signal.throwIfAborted();
    const settings = await getSettings(db);
    const deadlineMs = provider.transport === 'mock' ? settings.mock.timeoutMs : POLL_DEFAULT_DEADLINE_MS;
    const { externalId } = await provider.submit({ ...request, idempotencyKey: `${gen.id}-${gen.submitAttempts + 1}` }, { signal });
    const [updated] = await db.update(generations).set({
      externalId, status: 'submitted', submittedAt: new Date(), deadlineAt: new Date(Date.now() + deadlineMs),
      submitAttempts: sql`${generations.submitAttempts} + 1`, jobId: ctx.job.id, progress: 0, updatedAt: new Date(),
    }).where(eq(generations.id, gen.id)).returning();
    await recordCost(db, { projectId: gen.projectId, sceneId: gen.sceneId, generationId: gen.id, kind: 'estimate', capability: gen.capability, provider: gen.provider, model: gen.model, estimate: provider.estimateCost(request) });
    await ctx.progress(0.02, 'Submitted to provider');
    return { state: 'waiting', gen: updated };
  }

  const res = await provider.poll(gen.externalId, { signal });
  if (res.status === 'succeeded' && res.output) return { state: 'succeeded', gen, output: res.output, actualCost: res.actualCost };
  if (res.status === 'failed') {
    await db.update(generations).set({ status: 'failed', error: res.error ?? 'Provider reported failure', externalId: null, updatedAt: new Date() }).where(eq(generations.id, gen.id));
    throw new AppError('PROVIDER_ERROR', res.error ?? 'Provider reported failure', { retryable: res.retryable ?? true });
  }
  if (gen.deadlineAt && Date.now() > gen.deadlineAt.getTime()) {
    await provider.cancel?.(gen.externalId).catch(() => undefined);
    await db.update(generations).set({ status: 'timed_out', error: 'Provider did not finish before the deadline', externalId: null, updatedAt: new Date() }).where(eq(generations.id, gen.id));
    throw new AppError('PROVIDER_TIMEOUT', `${provider.displayName} did not finish within the deadline; will resubmit if attempts remain.`);
  }
  const [updated] = await db.update(generations).set({ status: 'running', progress: res.progress, updatedAt: new Date() }).where(eq(generations.id, gen.id)).returning();
  await ctx.progress(0.05 + res.progress * 0.9, res.message ?? 'Generating');
  return { state: 'waiting', gen: updated };
}

export async function markGenerationSucceeded(db: Tx, gen: GenerationRow, assetId: string, actual: CostEstimate | undefined): Promise<void> {
  const provider = getProvider(gen.provider);
  const cost = actual ?? provider.estimateCost(gen.params as unknown as GenerationRequest);
  await db.update(generations).set({ status: 'succeeded', progress: 1, outputAssetId: assetId, actualCostUsd: cost.amountUsd, error: null, updatedAt: new Date() }).where(eq(generations.id, gen.id));
  await recordCost(db, { projectId: gen.projectId, sceneId: gen.sceneId, generationId: gen.id, kind: 'actual', capability: gen.capability, provider: gen.provider, model: gen.model, estimate: cost });
}

/** Terminal failure bookkeeping (idempotent). */
export async function markGenerationFailed(db: Tx, generationId: string, error: AppError): Promise<GenerationRow | undefined> {
  const gen = await db.query.generations.findFirst({ where: eq(generations.id, generationId) });
  if (!gen || gen.status === 'succeeded') return gen;
  if (gen.externalId) {
    try { await getProvider(gen.provider).cancel?.(gen.externalId); } catch { /* provider may already be done */ }
  }
  const [row] = await db.update(generations).set({
    status: error.code === 'CANCELLED' ? 'cancelled' : error.code === 'PROVIDER_TIMEOUT' ? 'timed_out' : 'failed',
    error: error.message.slice(0, 2000), externalId: null, updatedAt: new Date(),
  }).where(eq(generations.id, generationId)).returning();
  return row;
}

export const POLL_INTERVAL_MS = 1000;
