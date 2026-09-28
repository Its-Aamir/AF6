import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { costEntries, generations, projects } from '../db/schema';
import { AppError } from '../errors';
import type { CostEstimate } from '../providers/types';

export interface CostSummary { spentUsd: number; pendingUsd: number; budgetUsd: number; remainingUsd: number }

const ACTIVE_GEN = ['pending', 'submitted', 'running'];

export async function projectCostSummary(db: Tx, projectId: string, budgetUsd: number): Promise<CostSummary> {
  const [spent] = await db.select({ v: sql<string>`coalesce(sum(${costEntries.amountUsd}),0)` }).from(costEntries)
    .where(and(eq(costEntries.projectId, projectId), eq(costEntries.kind, 'actual')));
  const [pending] = await db.select({ v: sql<string>`coalesce(sum(${generations.estimatedCostUsd}),0)` }).from(generations)
    .where(and(eq(generations.projectId, projectId), inArray(generations.status, ACTIVE_GEN)));
  const spentUsd = round4(Number(spent.v));
  const pendingUsd = round4(Number(pending.v));
  return { spentUsd, pendingUsd, budgetUsd, remainingUsd: round4(budgetUsd - spentUsd - pendingUsd) };
}

/** Budget guard. Called before enqueueing any billable generation. */
export async function assertWithinBudget(db: Tx, projectId: string, additionalUsd: number): Promise<void> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId), columns: { budgetUsd: true } });
  if (!project) throw new AppError('NOT_FOUND', 'Project not found');
  const s = await projectCostSummary(db, projectId, project.budgetUsd);
  if (additionalUsd > s.remainingUsd + 1e-9) {
    throw new AppError('BUDGET_EXCEEDED', `This would cost ~$${additionalUsd.toFixed(3)} but only $${Math.max(0, s.remainingUsd).toFixed(3)} of the $${s.budgetUsd.toFixed(2)} budget remains.`, {
      details: { ...s, requestedUsd: round4(additionalUsd) },
    });
  }
}

export async function recordCost(
  db: Tx,
  entry: { projectId: string | null; sceneId?: string | null; generationId?: string | null; kind: 'estimate' | 'actual'; capability: string; provider: string; model: string; estimate: CostEstimate },
): Promise<void> {
  await db.insert(costEntries).values({
    projectId: entry.projectId, sceneId: entry.sceneId ?? null, generationId: entry.generationId ?? null, kind: entry.kind,
    capability: entry.capability, provider: entry.provider, model: entry.model,
    units: entry.estimate.units, unit: entry.estimate.unit, unitCostUsd: entry.estimate.unitCostUsd,
    amountUsd: entry.estimate.amountUsd, simulated: entry.estimate.simulated,
  });
}

export function round4(n: number) { return Math.round(n * 10000) / 10000; }
