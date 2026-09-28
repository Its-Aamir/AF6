/** Validated media uploads (untrusted input): extension allow-list, container check, decode check. */
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import type { AssetKind } from '../../shared/schemas';
import type { Tx } from '../db/client';
import type { AssetRow } from '../db/schema';
import { AppError } from '../errors';
import { probe } from '../media/ffmpeg';
import { getStorage } from '../storage/storage';
import { ingestFile } from './assets';

export const UPLOAD_TYPES: Record<string, { mediaType: 'image' | 'video' | 'audio'; mime: string; formats: string[] }> = {
  png: { mediaType: 'image', mime: 'image/png', formats: ['png_pipe'] },
  jpg: { mediaType: 'image', mime: 'image/jpeg', formats: ['jpeg_pipe'] },
  jpeg: { mediaType: 'image', mime: 'image/jpeg', formats: ['jpeg_pipe'] },
  webp: { mediaType: 'image', mime: 'image/webp', formats: ['webp_pipe'] },
  mp4: { mediaType: 'video', mime: 'video/mp4', formats: ['mov,mp4,m4a,3gp,3g2,mj2'] },
  mov: { mediaType: 'video', mime: 'video/quicktime', formats: ['mov,mp4,m4a,3gp,3g2,mj2'] },
  webm: { mediaType: 'video', mime: 'video/webm', formats: ['matroska,webm'] },
  wav: { mediaType: 'audio', mime: 'audio/wav', formats: ['wav'] },
  mp3: { mediaType: 'audio', mime: 'audio/mpeg', formats: ['mp3'] },
  m4a: { mediaType: 'audio', mime: 'audio/mp4', formats: ['mov,mp4,m4a,3gp,3g2,mj2'] },
  aac: { mediaType: 'audio', mime: 'audio/aac', formats: ['aac'] },
  flac: { mediaType: 'audio', mime: 'audio/flac', formats: ['flac'] },
  ogg: { mediaType: 'audio', mime: 'audio/ogg', formats: ['ogg'] },
};

export async function receiveUpload(
  db: Tx,
  file: MultipartFile | undefined,
  opts: { projectId: string | null; kind: AssetKind; allow: ('image' | 'video' | 'audio')[] },
): Promise<AssetRow> {
  if (!file) throw new AppError('VALIDATION_ERROR', 'No file uploaded');
  const ext = path.extname(file.filename).slice(1).toLowerCase();
  const type = UPLOAD_TYPES[ext];
  const allowedExts = Object.entries(UPLOAD_TYPES).filter(([, t]) => opts.allow.includes(t.mediaType)).map(([e]) => e);
  if (!type || !opts.allow.includes(type.mediaType)) {
    file.file.resume();
    throw new AppError('UPLOAD_REJECTED', `Unsupported file type ".${ext}". Allowed: ${allowedExts.join(', ')}`);
  }
  const dir = await getStorage().tmpDir('upload');
  try {
    const tmp = path.join(dir, `upload.${ext}`);
    await pipeline(file.file, createWriteStream(tmp));
    if (file.file.truncated) throw new AppError('UPLOAD_REJECTED', 'File exceeds the upload size limit');
    let p;
    try { p = await probe(tmp); } catch { throw new AppError('UPLOAD_REJECTED', 'File could not be decoded as media'); }
    // ffprobe will "decode" text as tty video, so the container must match the extension.
    if (!type.formats.includes(p.formatName)) throw new AppError('UPLOAD_REJECTED', `File content (${p.formatName || 'unknown'}) does not match .${ext}`);
    const ok = type.mediaType === 'audio' ? p.hasAudio && (p.durationSec ?? 0) > 0.3 : type.mediaType === 'video' ? p.hasVideo && (p.durationSec ?? 0) > 0.1 : p.hasVideo;
    if (!ok) throw new AppError('UPLOAD_REJECTED', `File content does not match a valid ${type.mediaType}`);
    const label = path.basename(file.filename).replace(/[^\w.\- ]+/g, '').slice(0, 120) || `upload.${ext}`;
    return await ingestFile(db, { projectId: opts.projectId, kind: opts.kind, mediaType: type.mediaType, source: 'uploaded', label, srcPath: tmp, ext, mime: type.mime, move: true });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
