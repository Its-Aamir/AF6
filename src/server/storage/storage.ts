/**
 * Storage abstraction. Keys are ALWAYS generated server-side; callers never pass
 * user-controlled paths. LocalStorage is Phase 1; an S3 adapter can implement the
 * same interface later.
 */
import { createReadStream, type ReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import { AppError } from '../errors';

export interface StorageAdapter {
  /** Absolute local path for a key (local adapter) — used by ffmpeg. */
  resolve(key: string): string;
  ensureDirFor(key: string): Promise<string>;
  putFile(key: string, sourcePath: string): Promise<{ bytes: number }>;
  putBuffer(key: string, data: Buffer): Promise<{ bytes: number }>;
  stat(key: string): Promise<{ bytes: number } | null>;
  createReadStream(key: string, range?: { start: number; end: number }): ReadStream;
  delete(key: string): Promise<void>;
  tmpDir(prefix: string): Promise<string>;
}

const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_\-./]{0,400}$/;

export class LocalStorage implements StorageAdapter {
  constructor(private readonly root: string) {}

  resolve(key: string): string {
    if (!KEY_RE.test(key) || key.includes('..')) throw new AppError('VALIDATION_ERROR', `Invalid storage key`);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new AppError('VALIDATION_ERROR', 'Storage key escapes root');
    return full;
  }

  async ensureDirFor(key: string): Promise<string> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    return full;
  }

  async putFile(key: string, sourcePath: string) {
    const dest = await this.ensureDirFor(key);
    if (path.resolve(sourcePath) !== dest) {
      try { await fs.rename(sourcePath, dest); } catch { await fs.copyFile(sourcePath, dest); await fs.rm(sourcePath, { force: true }); }
    }
    return { bytes: (await fs.stat(dest)).size };
  }

  async putBuffer(key: string, data: Buffer) {
    const dest = await this.ensureDirFor(key);
    await fs.writeFile(dest, data);
    return { bytes: data.length };
  }

  async stat(key: string) {
    try { return { bytes: (await fs.stat(this.resolve(key))).size }; } catch { return null; }
  }

  createReadStream(key: string, range?: { start: number; end: number }) {
    return createReadStream(this.resolve(key), range);
  }

  async delete(key: string) {
    await fs.rm(this.resolve(key), { force: true });
  }

  async tmpDir(prefix: string) {
    const base = path.join(this.root, 'tmp');
    await fs.mkdir(base, { recursive: true });
    return fs.mkdtemp(path.join(base, `${prefix.replace(/[^a-z0-9-]/gi, '')}-`));
  }
}

let instance: StorageAdapter | null = null;
export function getStorage(): StorageAdapter {
  if (!instance) instance = new LocalStorage(config.storageDir);
  return instance;
}
