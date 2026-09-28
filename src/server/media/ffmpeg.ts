/**
 * Thin, safe wrappers around ffmpeg/ffprobe. Arguments are always passed as an
 * argv array (no shell). User text never enters filter strings directly — use
 * textfile= or generated subtitle files.
 */
import { spawn } from 'node:child_process';
import { config } from '../config';
import { AppError } from '../errors';

/**
 * Quote a server-generated file path for use inside a filtergraph option value,
 * e.g. `subtitles=filename='${filterPath(p)}'`. Works for Windows paths
 * (C:\\Users\\Jane Doe\\…): backslashes become forward slashes, and ':' is
 * escaped for the option parser. The single quotes protect the graph level.
 * A path containing a quote or control character is refused rather than escaped.
 */
export function filterPath(p: string): string {
  if (/['\u0000-\u001f]/.test(p)) throw new AppError('MEDIA_ERROR', `Unsupported characters in media path: ${p}`, { retryable: false });
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Called with 0..1 when `totalSec` is provided (parses -progress output). */
  onProgress?: (fraction: number) => void;
  totalSec?: number;
}

export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const full = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...(opts.onProgress ? ['-progress', 'pipe:1', '-nostats'] : []), ...args];
    const child = spawn(config.ffmpegPath, full, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (buf: Buffer) => {
      if (!opts.onProgress || !opts.totalSec) return;
      const m = /out_time_(?:us|ms)=(\d+)/.exec(buf.toString());
      if (m) opts.onProgress(Math.min(1, Number(m[1]) / 1e6 / opts.totalSec));
    });
    child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-4000); });
    child.on('error', (err) => reject(new AppError('MEDIA_ERROR', `Failed to start ffmpeg (${config.ffmpegPath}): ${err.message}`, { retryable: false })));
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(new AppError('JOB_TIMEOUT', 'ffmpeg aborted'));
      if (code === 0) resolve();
      else reject(new AppError('MEDIA_ERROR', `ffmpeg exited with code ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

export interface ProbeResult {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  formatName: string;
}

export function probe(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
    child.on('error', (e) => reject(new AppError('MEDIA_ERROR', `Failed to start ffprobe: ${e.message}`, { retryable: false })));
    child.on('close', (code) => {
      if (code !== 0) return reject(new AppError('MEDIA_ERROR', `ffprobe failed: ${err.trim().slice(0, 300)}`, { retryable: false }));
      try {
        const j = JSON.parse(out) as { format?: { duration?: string; format_name?: string }; streams?: { codec_type: string; width?: number; height?: number; duration?: string }[] };
        const streams = j.streams ?? [];
        const v = streams.find((s) => s.codec_type === 'video');
        const a = streams.find((s) => s.codec_type === 'audio');
        const d = Number(j.format?.duration ?? v?.duration ?? a?.duration);
        resolve({
          durationSec: Number.isFinite(d) ? d : null,
          width: v?.width ?? null,
          height: v?.height ?? null,
          hasVideo: !!v,
          hasAudio: !!a,
          formatName: j.format?.format_name ?? '',
        });
      } catch (e) {
        reject(new AppError('MEDIA_ERROR', `Unparseable ffprobe output: ${(e as Error).message}`));
      }
    });
  });
}

export async function checkMediaTooling(): Promise<{ ok: boolean; error?: string }> {
  try {
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=0.1', '-f', 'null', '-']);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
