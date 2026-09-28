/**
 * Server-side configuration. Secrets live ONLY here (process env) and are never
 * serialized to the client — routes expose booleans ("configured") at most.
 */
import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1).default('postgres://studio:studio@localhost:5432/studio'),
  TEST_DATABASE_URL: z.string().min(1).default('postgres://studio:studio@localhost:5432/studio_test'),
  STORAGE_DIR: z.string().default('./data/storage'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(8787),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  WORKER_POLL_MS: z.coerce.number().int().min(50).max(10_000).default(500),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(4096).default(200),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  /** Directory with DejaVuSans.ttf / DejaVuSans-Bold.ttf (captions + mock visuals). */
  FONT_DIR: z.string().default('/usr/share/fonts/truetype/dejavu'),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail loudly at boot rather than misbehave later.
  console.error('Invalid environment configuration:', parsed.error.issues);
  process.exit(1);
}
const env = parsed.data;
const isTest = env.NODE_ENV === 'test';

export const config = {
  env: env.NODE_ENV,
  isTest,
  databaseUrl: isTest ? env.TEST_DATABASE_URL : env.DATABASE_URL,
  storageDir: path.resolve(isTest ? path.join(env.STORAGE_DIR, '..', 'test-storage') : env.STORAGE_DIR),
  host: env.HOST,
  port: env.PORT,
  workerConcurrency: env.WORKER_CONCURRENCY,
  workerPollMs: env.WORKER_POLL_MS,
  maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024,
  ffmpegPath: env.FFMPEG_PATH,
  ffprobePath: env.FFPROBE_PATH,
  fontDir: path.resolve(env.FONT_DIR),
  logLevel: isTest ? 'silent' : env.LOG_LEVEL,
};

/** Presence check for provider credentials. Never returns the value. */
export function hasEnv(name: string): boolean {
  const v = process.env[name];
  return typeof v === 'string' && v.trim().length > 0;
}
