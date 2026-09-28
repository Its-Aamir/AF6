/** Migrates the dedicated test database once per run. Never touches the dev DB. */
export default async function setup() {
  process.env.NODE_ENV = 'test';
  const { runMigrations } = await import('../src/server/db/migrate');
  const { closeDb } = await import('../src/server/db/client');
  const { config } = await import('../src/server/config');
  if (!config.databaseUrl.includes('test')) throw new Error(`Refusing to run tests against non-test database: ${config.databaseUrl}`);
  await runMigrations();
  await closeDb();
}
