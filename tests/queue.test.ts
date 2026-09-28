import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { closeDb, getDb } from '../src/server/db/client';
import { jobs } from '../src/server/db/schema';
import { AppError } from '../src/server/errors';
import { registerHandler } from '../src/server/jobs/registry';
import { done, reschedule, type JobHandler } from '../src/server/jobs/types';
import { claimJob, enqueue } from '../src/server/queue/queue';
import { cancelJob } from '../src/server/services/projects';
import { resetDb, startWorker, waitFor } from './helpers';

type P = { mode: string; id?: string };
const calls: Record<string, number> = {};
const failed: string[] = [];
const T = 'test.job' as never;

const handler: JobHandler<P> = {
  type: T,
  payloadSchema: z.object({ mode: z.string(), id: z.string().optional() }),
  async run({ payload, job, signal, progress }) {
    const key = payload.id ?? job.id;
    calls[key] = (calls[key] ?? 0) + 1;
    switch (payload.mode) {
      case 'ok': await progress(0.5, 'half'); return done({ ok: true });
      case 'flaky': if (calls[key] < 3) throw new AppError('PROVIDER_ERROR', 'transient'); return done();
      case 'fatal': throw new AppError('VALIDATION_ERROR', 'bad input');
      case 'always': throw new AppError('PROVIDER_ERROR', 'still broken');
      case 'poll': return calls[key] < 4 ? reschedule(10) : done({ polls: calls[key] });
      case 'hang': await new Promise((r, j) => signal.addEventListener('abort', () => j(signal.reason))); return done();
      case 'slow': await new Promise((r) => setTimeout(r, 1500)); return done();
      default: throw new Error('unknown mode');
    }
  },
  async onFailed({ job }) { failed.push(job.id); },
};
registerHandler(handler as never);

const add = (payload: P, extra: Record<string, unknown> = {}) => enqueue(getDb(), { type: T, payload, ...extra } as never);
const get = async (id: string) => (await getDb().query.jobs.findFirst({ where: eq(jobs.id, id) }))!;
const until = (id: string, statuses: string[], timeoutMs = 10_000) => waitFor(async () => { const j = await get(id); return statuses.includes(j.status) ? j : null; }, { timeoutMs, label: statuses.join('|') });

beforeEach(async () => { await resetDb(); failed.length = 0; });
afterAll(async () => { await closeDb(); });

describe('durable job queue', () => {
  it('runs a job to success and records progress/result', async () => {
    const w = startWorker();
    const { job } = await add({ mode: 'ok' });
    const j = await until(job.id, ['succeeded']);
    expect(j.result).toEqual({ ok: true });
    expect(j.progress).toBe(1);
    expect(j.attempts).toBe(1);
    await w.stop();
  });

  it('deduplicates active jobs by key', async () => {
    const a = await add({ mode: 'ok' }, { dedupeKey: 'k1' });
    const b = await add({ mode: 'ok' }, { dedupeKey: 'k1' });
    expect(b.deduped).toBe(true);
    expect(b.job.id).toBe(a.job.id);
  });

  it('retries retryable errors with backoff, then succeeds', async () => {
    const w = startWorker();
    const { job } = await add({ mode: 'flaky' });
    const j = await until(job.id, ['succeeded']);
    expect(j.attempts).toBe(3);
    await w.stop();
  });

  it('fails non-retryable errors immediately and runs the failure hook', async () => {
    const w = startWorker();
    const { job } = await add({ mode: 'fatal' });
    const j = await until(job.id, ['failed']);
    expect(j.attempts).toBe(1);
    expect(j.errorCode).toBe('VALIDATION_ERROR');
    expect(failed).toContain(job.id);
    await w.stop();
  });

  it('gives up after max attempts', async () => {
    const w = startWorker();
    const { job } = await add({ mode: 'always' }, { maxAttempts: 3 });
    const j = await until(job.id, ['failed']);
    expect(j.attempts).toBe(3);
    expect(j.error).toBe('still broken');
    expect(failed).toContain(job.id);
    await w.stop();
  });

  it('reschedules (polling) without consuming attempts', async () => {
    const w = startWorker();
    const { job } = await add({ mode: 'poll' }, { maxAttempts: 1 });
    const j = await until(job.id, ['succeeded']);
    expect(j.result).toEqual({ polls: 4 });
    await w.stop();
  });

  it('enforces the job timeout', async () => {
    const w = startWorker();
    const { job } = await add({ mode: 'hang' }, { timeoutMs: 300, maxAttempts: 1 });
    const j = await until(job.id, ['failed']);
    expect(j.errorCode).toBe('JOB_TIMEOUT');
    await w.stop();
  });

  it('reclaims jobs whose worker crashed (lease expiry)', async () => {
    const w1 = startWorker({ leaseMs: 400 });
    const { job } = await add({ mode: 'slow', id: 'crash' });
    await until(job.id, ['running']);
    await w1.stop({ simulateCrash: true });
    expect((await get(job.id)).status).toBe('running'); // abandoned, lease still held
    const w2 = startWorker({ leaseMs: 400 });
    const j = await until(job.id, ['succeeded']);
    expect(j.attempts).toBe(2);
    await w2.stop();
  });

  it('never lets two workers claim the same job', async () => {
    for (let i = 0; i < 20; i++) await add({ mode: 'ok' });
    const db = getDb();
    const claims = await Promise.all(Array.from({ length: 30 }, (_, i) => claimJob(db, `w${i}`, 10_000)));
    const ids = claims.filter(Boolean).map((j) => j!.id);
    expect(ids.length).toBe(20);
    expect(new Set(ids).size).toBe(20);
  });

  it('cancels queued jobs immediately and running jobs cooperatively', async () => {
    const { job: q } = await add({ mode: 'ok' }, { runAt: new Date(Date.now() + 60_000) });
    expect((await cancelJob(getDb(), q.id)).status).toBe('cancelled');
    const w = startWorker();
    const { job: r } = await add({ mode: 'hang' });
    await until(r.id, ['running']);
    await cancelJob(getDb(), r.id);
    const j = await until(r.id, ['cancelled']);
    expect(j.errorCode).toBe('CANCELLED');
    await w.stop();
  });
});
