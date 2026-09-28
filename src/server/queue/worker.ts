/**
 * Worker runtime: claims jobs, runs handlers under timeout + heartbeat, and
 * records outcomes. Safe to run several workers concurrently.
 */
import os from 'node:os';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { jobs, type JobRow } from '../db/schema';
import { AppError, toAppError } from '../errors';
import { getHandler } from '../jobs/registry';
import { claimJob, completeJob, failJob, heartbeat, rescheduleJob } from './queue';

export interface WorkerOptions {
  concurrency: number;
  pollMs: number;
  leaseMs?: number;
  backoffBaseMs?: number;
  types?: readonly string[];
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export class Worker {
  readonly id = `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  private running = false;
  private crashed = false;
  private active = new Map<string, AbortController>();
  private loopPromise: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private readonly leaseMs: number;
  private readonly log: NonNullable<WorkerOptions['log']>;

  constructor(private db: Db, private opts: WorkerOptions) {
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.log = opts.log ?? ((m, e) => console.log(`[worker] ${m}`, e ?? ''));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  /**
   * Stop claiming and wait for in-flight jobs. With simulateCrash the worker
   * abandons in-flight jobs without recording anything (like a killed process);
   * their leases expire and another worker reclaims them.
   */
  async stop({ simulateCrash = false } = {}): Promise<void> {
    this.running = false;
    this.wake?.();
    if (simulateCrash) {
      this.crashed = true;
      for (const c of this.active.values()) c.abort(new AppError('CANCELLED', 'Simulated crash'));
    }
    await this.loopPromise;
    while (this.active.size) await new Promise((r) => setTimeout(r, 50));
  }

  get inFlight(): number { return this.active.size; }

  private async loop(): Promise<void> {
    while (this.running) {
      let claimed = false;
      while (this.running && this.active.size < this.opts.concurrency) {
        let job: JobRow | null = null;
        try {
          job = await claimJob(this.db, this.id, this.leaseMs, this.opts.types);
        } catch (err) {
          this.log('claim failed', { error: (err as Error).message });
          break;
        }
        if (!job) break;
        claimed = true;
        const ctl = new AbortController();
        this.active.set(job.id, ctl);
        void this.execute(job, ctl).finally(() => { this.active.delete(job!.id); this.wake?.(); });
      }
      if (!this.running) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, claimed ? 20 : this.opts.pollMs);
        this.wake = () => { clearTimeout(t); resolve(); };
      });
      this.wake = null;
    }
  }

  private async execute(job: JobRow, ctl: AbortController): Promise<void> {
    const handler = getHandler(job.type);
    const log = (msg: string, extra?: Record<string, unknown>) => this.log(`${job.type} ${job.id.slice(0, 8)}: ${msg}`, extra);
    if (!handler) {
      await failJob(this.db, job, this.id, new AppError('INTERNAL', `No handler registered for job type ${job.type}`, { retryable: false }));
      return;
    }
    const parsed = handler.payloadSchema.safeParse(job.payload);
    const terminal = async (error: AppError) => {
      if (!parsed.success || !handler.onFailed) return;
      try {
        await handler.onFailed({ job, payload: parsed.data, db: this.db, error });
      } catch (hookErr) {
        this.log(`onFailed hook error for ${job.id}`, { error: (hookErr as Error).message });
        await this.db.update(jobs).set({ error: `${error.message} (revert hook failed: ${(hookErr as Error).message})` }).where(eq(jobs.id, job.id));
      }
    };
    if (!parsed.success) {
      await failJob(this.db, job, this.id, new AppError('VALIDATION_ERROR', `Invalid job payload: ${parsed.error.issues[0]?.message}`));
      return;
    }
    if (job.cancelRequested) {
      const err = new AppError('CANCELLED', 'Cancelled by user');
      await failJob(this.db, job, this.id, err);
      await terminal(err);
      return;
    }
    if (job.attempts > job.maxAttempts) {
      const err = new AppError('INTERNAL', job.error ? `Gave up after ${job.maxAttempts} attempts: ${job.error}` : `Gave up after ${job.maxAttempts} attempts (worker lease expired repeatedly)`, { retryable: false });
      await failJob(this.db, job, this.id, err);
      await terminal(err);
      return;
    }

    let lostLease = false;
    let lastProgress: { fraction: number; message?: string } | undefined;
    const hb = setInterval(async () => {
      if (this.crashed) return;
      try {
        const r = await heartbeat(this.db, job.id, this.id, this.leaseMs, lastProgress);
        if (!r.owned) { lostLease = true; ctl.abort(new AppError('CANCELLED', 'Lease lost')); }
        else if (r.cancelRequested) ctl.abort(new AppError('CANCELLED', 'Cancelled by user'));
      } catch (e) { this.log('heartbeat error', { error: (e as Error).message }); }
    }, Math.max(250, Math.floor(this.leaseMs / 3)));
    const timeout = setTimeout(() => ctl.abort(new AppError('JOB_TIMEOUT', `Job exceeded its ${Math.round(job.timeoutMs / 1000)}s time limit`)), job.timeoutMs);

    try {
      const abortPromise = new Promise<never>((_, reject) => {
        ctl.signal.addEventListener('abort', () => reject(ctl.signal.reason), { once: true });
      });
      const outcome = await Promise.race([
        handler.run({
          job, payload: parsed.data, db: this.db, signal: ctl.signal, log,
          progress: async (fraction, message) => {
            lastProgress = { fraction, message };
            if (this.crashed) return;
            await heartbeat(this.db, job.id, this.id, this.leaseMs, lastProgress);
          },
        }),
        abortPromise,
      ]);
      if (this.crashed) return;
      if (outcome.kind === 'reschedule') await rescheduleJob(this.db, job.id, this.id, outcome.delayMs);
      else await completeJob(this.db, job.id, this.id, outcome.result ?? {});
    } catch (raw) {
      if (this.crashed) return;
      if (lostLease) { log('lease lost; another worker owns this job now'); return; }
      const err = toAppError(raw);
      const status = await failJob(this.db, job, this.id, err, this.opts.backoffBaseMs);
      log(status === 'retrying' ? `failed, will retry: ${err.message}` : `failed permanently: ${err.message}`);
      if (status === 'failed') await terminal(err);
    } finally {
      clearInterval(hb);
      clearTimeout(timeout);
    }
  }
}
