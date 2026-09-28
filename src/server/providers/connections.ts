/**
 * Provider connection store. Rows live in Postgres (secrets encrypted); both the
 * API and the worker keep a short-lived in-memory cache so provider lookups stay
 * synchronous. Call refreshConnections() at request/job boundaries.
 */
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { providerConnections, type ConnectionModel, type ProviderConnectionRow } from '../db/schema';
import { decryptJson, encryptJson } from '../security/secrets';

interface Cached { row: ProviderConnectionRow; secret?: unknown }
let cache = new Map<string, Cached>();
let loadedAt = 0;

export async function refreshConnections(db: Tx, maxAgeMs = 2000): Promise<void> {
  if (Date.now() - loadedAt < maxAgeMs) return;
  const rows = await db.select().from(providerConnections);
  cache = new Map(rows.map((r) => [r.providerId, { row: r }]));
  loadedAt = Date.now();
}

export function invalidateConnections(): void { loadedAt = 0; }

export function getConnection(providerId: string): ProviderConnectionRow | undefined {
  return cache.get(providerId)?.row;
}

export function getSecret<T>(providerId: string): T | undefined {
  const c = cache.get(providerId);
  if (!c?.row.secretCiphertext) return undefined;
  if (c.secret === undefined) c.secret = decryptJson<T>(c.row.secretCiphertext);
  return c.secret as T;
}

export async function loadConnection(db: Tx, providerId: string): Promise<{ row?: ProviderConnectionRow; secret?: unknown }> {
  const row = await db.query.providerConnections.findFirst({ where: eq(providerConnections.providerId, providerId) });
  return { row, secret: row?.secretCiphertext ? decryptJson(row.secretCiphertext) : undefined };
}

export async function upsertConnection(
  db: Tx,
  providerId: string,
  patch: { status?: ProviderConnectionRow['status']; secret?: unknown | null; secretHint?: string | null; config?: Record<string, unknown>; models?: ConnectionModel[]; lastError?: string | null; lastTestedAt?: Date | null },
): Promise<ProviderConnectionRow> {
  const values: Partial<typeof providerConnections.$inferInsert> = { updatedAt: new Date() };
  if (patch.status) values.status = patch.status;
  if (patch.secret !== undefined) values.secretCiphertext = patch.secret === null ? null : encryptJson(patch.secret);
  if (patch.secretHint !== undefined) values.secretHint = patch.secretHint;
  if (patch.config) values.config = patch.config;
  if (patch.models) values.models = patch.models;
  if (patch.lastError !== undefined) values.lastError = patch.lastError;
  if (patch.lastTestedAt !== undefined) values.lastTestedAt = patch.lastTestedAt;
  const [row] = await db.insert(providerConnections)
    .values({ providerId, status: patch.status ?? 'error', ...values })
    .onConflictDoUpdate({ target: providerConnections.providerId, set: values })
    .returning();
  invalidateConnections();
  return row;
}

export async function deleteConnection(db: Tx, providerId: string): Promise<void> {
  await db.delete(providerConnections).where(eq(providerConnections.providerId, providerId));
  invalidateConnections();
}

/** Merge freshly discovered/catalog models with the user's existing choices (enabled flag, price, durations). */
export function mergeModels(existing: ConnectionModel[], incoming: ConnectionModel[]): ConnectionModel[] {
  const byId = new Map(existing.map((m) => [`${m.capability}:${m.id}`, m]));
  const merged = incoming.map((m) => {
    const prev = byId.get(`${m.capability}:${m.id}`);
    return prev ? { ...m, enabled: prev.enabled, unitCostUsd: prev.unitCostUsd ?? m.unitCostUsd, durations: prev.durations ?? m.durations, extraInput: prev.extraInput ?? m.extraInput } : m;
  });
  const customs = existing.filter((m) => m.source === 'custom' && !merged.some((x) => x.id === m.id && x.capability === m.capability));
  return [...merged, ...customs];
}
