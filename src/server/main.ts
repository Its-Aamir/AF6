import { config } from './config';
import { buildApp } from './app';
import { closeDb } from './db/client';
import { runMigrations } from './db/migrate';
import { checkMediaTooling } from './media/ffmpeg';

async function main() {
  await runMigrations();
  const media = await checkMediaTooling();
  if (!media.ok) console.error(`[api] WARNING: ffmpeg is not usable (${media.error}). Generation/render jobs will fail until it is installed.`);
  const app = await buildApp({ serveWeb: true });
  const shutdown = async () => { await app.close(); await closeDb(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => { console.error('[api] fatal', err); process.exit(1); });
