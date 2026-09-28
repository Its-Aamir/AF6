/**
 * Durable Postgres job queue.
 *  - enqueue inside the caller's transaction (atomic with the state change)
 *  - claim with FOR UPDATE SKIP LOCKED; expired leases are reclaimed (crash recovery)
 *  - heartbeat extends the lease; all writes are fenced by locked_by
 *  - retry with exponential backoff; reschedule (polling) without spending attempts
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { JobType } from '../../shared/schemas';
import type { Db, Tx } from '../db/client';
import { jobs, type JobRow } from '../db/schema';
import type { AppError } from '../errors';

export interface EnqueueOptions {
  type: JobType;
  payload: Record<string, unknown>;
  projectId?: string | null;
  sceneId?: string | null;
  dedupeKey?: string | null;
  priority?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  runAt?: Date;
}

export const JOB_DEFAULTS: Record<JobType, { maxAttempts: number; timeoutMs: number; priority: number }> = {
  'script.generate': { maxAttempts: 3, timeoutMs: 120_000, priority: 10 },
  'narration.generate': { maxAttempts: 4, timeoutMs: 120_000, priority: 10 },
  'scenes.segment': { maxAttempts: 2, timeoutMs: 30_000, priority: 10 },
  'visuals.plan': { maxAttempts: 3, timeoutMs: 120_000, priority: 10 },
  'scene.generate': { maxAttempts: 4, timeoutMs: 120_000, priority: 5 },
  'music.generate': { maxAttempts: 4, timeoutMs: 120_000, priority: 5 },
  'qa.run': { maxAttempts: 2, timeoutMs: 60_000, priority: 10 },
  'render.final': { maxAttempts: 2, timeoutMs: 1_800_000, priority: 1 },
  'package.export': { maxAttempts: 2, timeoutMs: 600_000, priority: 1 },
  'voice.preview': { maxAttempts: 3, timeoutMs: 60_000, priority: 8 },
  'narration.align': { maxAttempts: 3, timeoutMs: 600_000, priority: 10 },
  'project.autopilot': { maxAttempts: 6, timeoutMs: 120_000, priority: 20 },
};

export async function enqueue(db: Tx, opts: EnqueueOptions): Promise<{ job: JobRow; deduped: boolean }> {
  const d = JOB_DEFAULTS[opts.type] ?? { maxAttempts: 3, timeoutMs: 120_000, priority: 0 };
  const values = {
    type: opts.type,
    payload: opts.payload,
    projectId: opts.projectId ?? null,
    sceneId: opts.sceneId ?? null,
    dedupeKey: opts.dedupeKey ?? null,
    priority: opts.priority ?? d.priority,
    maxAttempts: opts.maxAttempts ?? d.maxAttempts,
    timeoutMs: opts.timeoutMs ?? d.timeoutMs,
    runAt: opts.runAt ?? new Date(),
  };
  const inserted = await db.insert(jobs).values(values)
    .onConflictDoNothing({ target: jobs.dedupeKey, where: sql`status in ('queued','running') and dedupe_key is not null` })
    .returning();
  if (inserted[0]) return { job: inserted[0], deduped: false };
  const existing = await db.query.jobs.findFirst({ where: and(eq(jobs.dedupeKey, opts.dedupeKey!), inArray(jobs.status, ['queued', 'running'])) });
  if (!existing) throw new Error('Dedupe conflict but no active job found');
  return { job: existing, deduped: true };
}

/** Claim one runnable job (queued & due, or running with an expired lease). */
export async function claimJob(db: Db, workerId: string, leaseMs: number, types?: readonly string[]): Promise<JobRow | null> {
  const typeFilter = types?.length ? sql`and type in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})` : sql``;
  const res = await db.execute(sql`
    update jobs set
      status = 'running',
      locked_by = ${workerId},
      locked_until = now() + (${leaseMs}::int * interval '1 millisecond'),
      attempts = attempts + 1,
      started_at = coalesce(started_at, now()),
      updated_at = now()
    where id = (
      select id from jobs
      where ((status = 'queued' and run_at <= now()) or (status = 'running' and locked_until < now()))
        ${typeFilter}
      order by priority desc, run_at asc
      limit 1
      for update skip locked
    )
    returning id`);
  const row = res.rows[0] as { id: string } | undefined;
  if (!row) return null;
  return (await db.query.jobs.findFirst({ where: eq(jobs.id, row.id) })) ?? null;
}

/** Extend lease + persist progress. Returns false if this worker lost the lease. */
export async function heartbeat(db: Db, jobId: string, workerId: string, leaseMs: number, progress?: { fraction: number; message?: string }): Promise<{ owned: boolean; cancelRequested: boolean }> {
  const res = await db.update(jobs).set({
    lockedUntil: sql`now() + (${leaseMs}::int * interval '1 millisecond')`,
    ...(progress ? { progress: Math.max(0, Math.min(1, progress.fraction)), progressMessage: progress.message ?? null } : {}),
    updatedAt: new Date(),
  }).where(and(eq(jobs.id, jobId), eq(jobs.lockedBy, workerId), eq(jobs.status, 'running'))).returning({ cancel: jobs.cancelRequested });
  return { owned: res.length > 0, cancelRequested: res[0]?.cancel ?? false };
}

export async function completeJob(db: Tx, jobId: string, workerId: string, result: Record<string, unknown>): Promise<boolean> {
  const res = await db.update(jobs).set({
    status: 'succeeded', result, progress: 1, lockedBy: null, lockedUntil: null, finishedAt: new Date(), updatedAt: new Date(), error: null, errorCode: null,
  }).where(and(eq(jobs.id, jobId), eq(jobs.lockedBy, workerId))).returning({ id: jobs.id });
  return res.length > 0;
}

/** Put the job back in the queue without consuming an attempt (used for provider polling). */
export async function rescheduleJob(db: Tx, jobId: string, workerId: string, delayMs: number): Promise<boolean> {
  const res = await db.update(jobs).set({
    status: 'queued', attempts: sql`greatest(attempts - 1, 0)`, runAt: sql`now() + (${delayMs}::int * interval '1 millisecond')`,
    lockedBy: null, lockedUntil: null, updatedAt: new Date(),
  }).where(and(eq(jobs.id, jobId), eq(jobs.lockedBy, workerId))).returning({ id: jobs.id });
  return res.length > 0;
}

export function backoffMs(attempt: number, base = 1000, cap = 60_000): number {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}

/** Record a failure: requeue with backoff if retryable and attempts remain, else terminal. */
export async function failJob(db: Tx, job: JobRow, workerId: string | null, err: AppError, backoffBaseMs = 1000): Promise<'retrying' | 'failed'> {
  const canRetry = err.retryable && job.attempts < job.maxAttempts && !job.cancelRequested;
  const where = workerId ? and(eq(jobs.id, job.id), eq(jobs.lockedBy, workerId)) : eq(jobs.id, job.id);
  if (canRetry) {
    await db.update(jobs).set({
      status: 'queued', runAt: new Date(Date.now() + backoffMs(job.attempts, backoffBaseMs)),
      error: err.message.slice(0, 2000), errorCode: err.code, lockedBy: null, lockedUntil: null, updatedAt: new Date(),
      progressMessage: `Retrying after error (attempt ${job.attempts}/${job.maxAttempts})`,
    }).where(where);
    return 'retrying';
  }
  await db.update(jobs).set({
    status: err.code === 'CANCELLED' ? 'cancelled' : 'failed',
    error: err.message.slice(0, 2000), errorCode: err.code, lockedBy: null, lockedUntil: null, finishedAt: new Date(), updatedAt: new Date(),
  }).where(where);
  return 'failed';
}
