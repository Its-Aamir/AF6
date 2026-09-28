import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, getDb } from './client';
import { seed } from './seed';

/** Locate ./drizzle whether running from src/ (tsx) or dist/ (bundled). */
function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(process.cwd(), 'drizzle'), path.resolve(here, '../../../drizzle'), path.resolve(here, '../../drizzle')];
  const found = candidates.find((p) => existsSync(path.join(p, 'meta', '_journal.json')));
  if (!found) throw new Error(`Migrations folder not found (looked in ${candidates.join(', ')})`);
  return found;
}

export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: migrationsFolder() });
  await seed(getDb());
}

// Only when executed as the migrate entry (not when bundled into another entry).
const invokedDirectly = /migrate\.(ts|js)$/.test(process.argv[1] ?? '');
if (invokedDirectly) {
  runMigrations()
    .then(() => { console.log('Migrations applied and seed data ensured.'); return closeDb(); })
    .catch(async (err) => { console.error('Migration failed:', err); await closeDb(); process.exit(1); });
}
