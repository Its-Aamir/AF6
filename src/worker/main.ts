/** Worker process: executes all long-running jobs. Run one or many. */
import { config } from '../server/config';
import { closeDb, getDb } from '../server/db/client';
import { runMigrations } from '../server/db/migrate';
import { checkMediaTooling } from '../server/media/ffmpeg';
import { exitWithParent } from '../server/parent';
import { Worker } from '../server/queue/worker';

async function main() {
  await runMigrations();
  const media = await checkMediaTooling();
  if (!media.ok) {
    console.error(`[worker] ffmpeg is required but not usable: ${media.error}`);
    process.exit(1);
  }
  const worker = new Worker(getDb(), { concurrency: config.workerConcurrency, pollMs: config.workerPollMs });
  worker.start();
  console.log(`[worker] ${worker.id} started (concurrency ${config.workerConcurrency})`);
  const shutdown = async (sig: string) => {
    console.log(`[worker] ${sig}: finishing in-flight jobs…`);
    await worker.stop();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  exitWithParent(() => void shutdown('parent exited'));
}

main().catch((err) => { console.error('[worker] fatal', err); process.exit(1); });
