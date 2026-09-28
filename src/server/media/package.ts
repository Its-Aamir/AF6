/** Project package export: a zip with the render, sources and a machine-readable manifest. */
import { createWriteStream } from 'node:fs';
import { ZipArchive } from 'archiver';

export interface PackageEntry { name: string; path?: string; content?: string | Buffer }

export async function writeZip(outPath: string, entries: PackageEntry[], signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(outPath);
    const zip = new ZipArchive({ zlib: { level: 6 } });
    const fail = (e: unknown) => { out.destroy(); reject(e); };
    signal?.addEventListener('abort', () => fail(signal.reason), { once: true });
    out.on('close', () => resolve());
    out.on('error', fail);
    zip.on('error', fail);
    zip.on('warning', fail);
    zip.pipe(out);
    for (const e of entries) {
      if (e.path) zip.file(e.path, { name: e.name });
      else if (e.content !== undefined) zip.append(e.content, { name: e.name });
    }
    zip.finalize().catch(fail);
  });
}
