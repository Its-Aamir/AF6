import { eq } from 'drizzle-orm';
import { SettingsSchema, type Settings } from '../../shared/schemas';
import type { Tx } from '../db/client';
import { settings } from '../db/schema';
import { DEFAULT_SETTINGS } from '../db/seed';

export async function getSettings(db: Tx): Promise<Settings> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, 'app') });
  const parsed = SettingsSchema.safeParse(row?.value);
  // Corrupt/missing settings fall back to defaults — but never silently: log it.
  if (!parsed.success) {
    if (row) console.warn('[settings] stored settings invalid, using defaults', parsed.error.issues);
    return DEFAULT_SETTINGS;
  }
  return parsed.data;
}

export async function saveSettings(db: Tx, value: Settings): Promise<Settings> {
  const v = SettingsSchema.parse(value);
  await db.insert(settings).values({ key: 'app', value: v }).onConflictDoUpdate({ target: settings.key, set: { value: v, updatedAt: new Date() } });
  return v;
}
