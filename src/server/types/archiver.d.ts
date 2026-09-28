// Minimal typings for archiver v8 (ships without declarations).
declare module 'archiver' {
  import type { Writable } from 'node:stream';
  import type { EventEmitter } from 'node:events';
  export class ZipArchive extends EventEmitter {
    constructor(opts?: { zlib?: { level?: number } });
    pipe(dest: Writable): Writable;
    file(path: string, data: { name: string }): this;
    append(source: string | Buffer, data: { name: string }): this;
    finalize(): Promise<void>;
    pointer(): number;
  }
}
