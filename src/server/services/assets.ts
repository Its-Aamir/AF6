/** Asset ingestion: every file entering storage goes through here (probe + row). */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import type { AssetKind, MediaType } from '../../shared/schemas';
import { config } from '../config';
import type { Tx } from '../db/client';
import { assets, type AssetRow } from '../db/schema';
import { AppError } from '../errors';
import { probe, runFfmpeg } from '../media/ffmpeg';
import type { ProviderOutput } from '../providers/types';
import { getStorage } from '../storage/storage';

export interface IngestOptions {
  projectId: string | null;
  sceneId?: string | null;
  generationId?: string | null;
  kind: AssetKind;
  mediaType: MediaType;
  source: 'generated' | 'uploaded' | 'rendered';
  label?: string;
  srcPath: string;
  ext: string;
  mime: string;
  /** Move instead of copy (for temp files we own). */
  move?: boolean;
  metadata?: Record<string, unknown>;
}

export function assetKey(projectId: string | null, kind: AssetKind, ext: string): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || 'bin';
  return `${projectId ? `projects/${projectId}` : 'library'}/${kind}/${randomUUID()}.${safeExt}`;
}

export async function ingestFile(db: Tx, o: IngestOptions): Promise<AssetRow> {
  const storage = getStorage();
  const key = assetKey(o.projectId, o.kind, o.ext);
  let durationSec: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  if (o.mediaType !== 'archive') {
    const p = await probe(o.srcPath);
    durationSec = o.mediaType === 'image' ? null : p.durationSec;
    width = p.width;
    height = p.height;
  }
  let bytes: number;
  if (o.move) bytes = (await storage.putFile(key, o.srcPath)).bytes;
  else {
    const dest = await storage.ensureDirFor(key);
    await fs.copyFile(o.srcPath, dest);
    bytes = (await fs.stat(dest)).size;
  }
  const metadata: Record<string, unknown> = { ...(o.metadata ?? {}) };
  if (o.mediaType === 'video') {
    try {
      metadata.thumbnailKey = await createVideoThumbnail(key, durationSec);
    } catch (e) {
      metadata.thumbnailError = (e as Error).message.slice(0, 200); // non-fatal, but recorded
    }
  }
  const [row] = await db.insert(assets).values({
    projectId: o.projectId, sceneId: o.sceneId ?? null, generationId: o.generationId ?? null,
    kind: o.kind, mediaType: o.mediaType, source: o.source, label: o.label ?? '', storageKey: key, mime: o.mime, bytes,
    durationSec, width, height, metadata,
  }).returning();
  return row;
}

/** Poster frame for a stored video: lets every browser show a still and keeps timeline strips light. */
export async function createVideoThumbnail(videoKey: string, durationSec: number | null): Promise<string> {
  const storage = getStorage();
  const thumbKey = videoKey.replace(/\.[a-z0-9]+$/, '.thumb.jpg');
  const at = Math.min(0.5, Math.max(0, (durationSec ?? 1) / 2));
  await runFfmpeg(['-ss', at.toFixed(2), '-i', storage.resolve(videoKey), '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', await storage.ensureDirFor(thumbKey)]);
  return thumbKey;
}

const MAX_REMOTE_BYTES = 2 * 1024 * 1024 * 1024;

/** Materialise a provider output to a local temp file (downloads URL outputs with limits). */
export async function materializeOutput(out: ProviderOutput, signal?: AbortSignal): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (out.kind === 'file') return { path: out.path, cleanup: async () => {} };
  const url = new URL(out.url);
  if (url.protocol !== 'https:' && !(config.isTest && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new AppError('PROVIDER_ERROR', 'Refusing non-HTTPS provider output URL', { retryable: false });
  const dir = await getStorage().tmpDir('download');
  const file = path.join(dir, `output.${out.ext.replace(/[^a-z0-9]/gi, '')}`);
  // Follow redirects manually so provider credentials are only ever sent to the original host.
  let res: Response = await fetch(url, { signal, headers: out.headers, redirect: 'manual' });
  let current = url;
  for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400 && res.headers.get('location'); hop++) {
    const next = new URL(res.headers.get('location')!, current);
    if (next.protocol !== 'https:' && !config.isTest) throw new AppError('PROVIDER_ERROR', 'Refusing non-HTTPS redirect for provider output', { retryable: false });
    const sameHost = next.host === url.host;
    res = await fetch(next, { signal, headers: sameHost ? out.headers : undefined, redirect: 'manual' });
    current = next;
  }
  if (!res.ok || !res.body) throw new AppError('PROVIDER_ERROR', `Downloading provider output failed: HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_REMOTE_BYTES) throw new AppError('PROVIDER_ERROR', 'Provider output too large', { retryable: false });
  let seen = 0;
  const body = Readable.fromWeb(res.body as never);
  body.on('data', (c: Buffer) => { seen += c.length; if (seen > MAX_REMOTE_BYTES) body.destroy(new Error('Provider output too large')); });
  await pipeline(body, createWriteStream(file));
  return { path: file, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

export function mediaTypeForCapability(cap: string): MediaType {
  return cap === 'image' ? 'image' : cap === 'video' ? 'video' : 'audio';
}
