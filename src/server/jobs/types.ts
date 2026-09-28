import type { z } from 'zod';
import type { JobType } from '../../shared/schemas';
import type { Db } from '../db/client';
import type { JobRow } from '../db/schema';
import type { AppError } from '../errors';

export type JobOutcome =
  | { kind: 'done'; result?: Record<string, unknown> }
  | { kind: 'reschedule'; delayMs: number };

export const done = (result: Record<string, unknown> = {}): JobOutcome => ({ kind: 'done', result });
export const reschedule = (delayMs: number): JobOutcome => ({ kind: 'reschedule', delayMs });

export interface JobContext<P> {
  job: JobRow;
  payload: P;
  db: Db;
  signal: AbortSignal;
  progress(fraction: number, message?: string): Promise<void>;
  log(msg: string, extra?: Record<string, unknown>): void;
}

export interface JobHandler<P = unknown> {
  type: JobType;
  payloadSchema: z.ZodType<P>;
  run(ctx: JobContext<P>): Promise<JobOutcome>;
  /** Terminal failure/cancel: revert domain state. Must be idempotent. */
  onFailed?(ctx: { job: JobRow; payload: P; db: Db; error: AppError }): Promise<void>;
}
