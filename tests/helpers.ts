import fs from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { config } from '../src/server/config';
import { getDb } from '../src/server/db/client';
import { seed } from '../src/server/db/seed';
import { Worker } from '../src/server/queue/worker';
import { saveSettings } from '../src/server/services/settings';
import type { MockSettings } from '../src/shared/schemas';

export async function resetDb(mock: Partial<MockSettings> = {}): Promise<void> {
  if (!config.isTest || !config.databaseUrl.includes('test')) throw new Error('resetDb outside test env');
  const db = getDb();
  await db.execute(sql`truncate jobs, cost_entries, generations, assets, scenes, projects, mock_provider_tasks, settings, recipes restart identity cascade`);
  await seed(db);
  await saveSettings(db, { defaultBudgetUsd: 25, mock: { latencyMs: 150, failureRate: 0, timeoutRate: 0, timeoutMs: 20_000, ...mock } });
  await fs.rm(config.storageDir, { recursive: true, force: true });
}

export function startWorker(opts: { leaseMs?: number; concurrency?: number } = {}): Worker {
  const w = new Worker(getDb(), { concurrency: opts.concurrency ?? 4, pollMs: 25, leaseMs: opts.leaseMs ?? 5000, backoffBaseMs: 50, log: () => {} });
  w.start();
  return w;
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, { timeoutMs = 60_000, intervalMs = 50, label = 'condition' } = {}): Promise<T> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${(last as Error).message}` : ''}`);
}
