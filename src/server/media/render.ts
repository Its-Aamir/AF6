/**
 * Deterministic renderer: Timeline JSON → MP4.
 *   1. each scene → exact-length segment (image: camera move, video: trim/loop)
 *   2. concat segments
 *   3. mix narration + (ducked) music, burn captions, encode, verify with ffprobe
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Timeline, TimelineClip } from '../../shared/schemas';
import { AppError } from '../errors';
import { toAss } from '../services/captions';
import { probe, runFfmpeg } from './ffmpeg';

export interface RenderOptions {
  preset: 'draft' | 'final';
  resolveAssetPath: (assetId: string) => string;
  workDir: string;
  outPath: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number, message: string) => Promise<void> | void;
}

/**
 * Paths embedded in a filtergraph must not need escaping. Work dirs are
 * server-generated, so we enforce a conservative character set instead of
 * attempting multi-level ffmpeg escaping.
 */
export function filterPath(p: string): string {
  if (!/^[A-Za-z0-9_\-./]+$/.test(p)) throw new AppError('MEDIA_ERROR', `Unsafe characters in render work path: ${p}`, { retryable: false });
  return p;
}

function motionFilter(motion: TimelineClip['motion'], W: number, H: number, dur: number): string {
  const cover = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
  const D = Math.max(0.1, dur).toFixed(3);
  const zoom = (from: number, to: number) =>
    `${cover},scale=w='trunc(${W}*(${from}+(${to - from})*t/${D})/2)*2':h=-2:eval=frame,crop=${W}:${H}`;
  const pad = `${cover},scale=${Math.round(W * 1.12 / 2) * 2}:-2`;
  switch (motion) {
    case 'slow_push_in': return zoom(1.0, 1.12);
    case 'slow_pull_out': return zoom(1.12, 1.0);
    case 'pan_left': return `${pad},crop=${W}:${H}:x='(in_w-${W})*(1-t/${D})':y='(in_h-${H})/2'`;
    case 'pan_right': case 'orbit': return `${pad},crop=${W}:${H}:x='(in_w-${W})*t/${D}':y='(in_h-${H})/2'`;
    case 'tilt_up': return `${pad},crop=${W}:${H}:x='(in_w-${W})/2':y='(in_h-${H})*(1-t/${D})'`;
    case 'handheld': return `${pad},crop=${W}:${H}:x='(in_w-${W})/2+sin(t*2.1)*${Math.round(W * 0.01)}':y='(in_h-${H})/2+cos(t*1.7)*${Math.round(H * 0.01)}'`;
    default: return cover;
  }
}

export async function renderTimeline(t: Timeline, o: RenderOptions): Promise<{ durationSec: number; width: number; height: number }> {
  const scale = o.preset === 'draft' ? 0.5 : 1;
  const W = Math.round((t.width * scale) / 2) * 2;
  const H = Math.round((t.height * scale) / 2) * 2;
  const fps = t.fps;
  const x264 = o.preset === 'draft' ? ['-preset', 'ultrafast', '-crf', '30'] : ['-preset', 'veryfast', '-crf', '21'];
  const report = async (f: number, m: string) => { await o.onProgress?.(Math.max(0, Math.min(1, f)), m); };
  await fs.mkdir(o.workDir, { recursive: true });

  // 1. segments with frame-exact lengths computed from the cumulative timeline (no drift)
  const segFiles: string[] = [];
  for (const [i, clip] of t.video.entries()) {
    o.signal?.throwIfAborted();
    const frames = Math.round(clip.end * fps) - Math.round(clip.start * fps);
    if (frames <= 0) throw new AppError('MEDIA_ERROR', `Scene ${clip.index} has zero length`, { retryable: false });
    const dur = frames / fps;
    const src = o.resolveAssetPath(clip.assetId);
    const out = path.join(o.workDir, `seg_${String(i).padStart(4, '0')}.mp4`);
    const common = ['-frames:v', String(frames), '-r', String(fps), '-c:v', 'libx264', ...x264, '-pix_fmt', 'yuv420p', '-an', out];
    if (clip.mediaKind === 'image') {
      await runFfmpeg(['-loop', '1', '-framerate', String(fps), '-t', (dur + 0.5).toFixed(3), '-i', src, '-vf', `${motionFilter(clip.motion, W, H, dur)},fps=${fps},format=yuv420p`, ...common], { signal: o.signal });
    } else {
      await runFfmpeg(['-stream_loop', '-1', '-i', src, '-t', (dur + 0.5).toFixed(3), '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps},format=yuv420p`, ...common], { signal: o.signal });
    }
    segFiles.push(out);
    await report(((i + 1) / t.video.length) * 0.5, `Rendered scene ${clip.index}/${t.video.length}`);
  }

  // 2. concat (identical codec params → stream copy)
  const list = path.join(o.workDir, 'concat.txt');
  await fs.writeFile(list, segFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  const videoOnly = path.join(o.workDir, 'video.mp4');
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', videoOnly], { signal: o.signal });
  await report(0.55, 'Mixing audio and captions');

  // 3. final mux
  const args: string[] = ['-i', videoOnly, '-i', o.resolveAssetPath(t.narration.assetId)];
  if (t.music) args.push('-stream_loop', '-1', '-i', o.resolveAssetPath(t.music.assetId));
  const filters: string[] = [];
  let vOut = '0:v';
  if (t.captions?.cues.length) {
    const assPath = path.join(o.workDir, 'captions.ass');
    await fs.writeFile(assPath, toAss(t.captions.cues, W, H, t.captions.position));
    filters.push(`[0:v]subtitles=filename='${filterPath(assPath)}'[vout]`);
    vOut = '[vout]';
  }
  filters.push(`[1:a]aresample=48000,aformat=channel_layouts=stereo,apad[nar]`);
  if (t.music) {
    filters.push(`[2:a]aresample=48000,aformat=channel_layouts=stereo,volume=${t.music.volume.toFixed(3)}[mus]`);
    if (t.music.duck) {
      filters.push(`[nar]asplit=2[nar1][nar2]`);
      filters.push(`[mus][nar2]sidechaincompress=threshold=0.02:ratio=6:attack=15:release=350[ducked]`);
      filters.push(`[nar1][ducked]amix=inputs=2:duration=first:normalize=0[aout]`);
    } else {
      filters.push(`[nar][mus]amix=inputs=2:duration=first:normalize=0[aout]`);
    }
  } else {
    filters.push(`[nar]anull[aout]`);
  }
  const total = Math.round(t.durationSec * fps) / fps;
  args.push(
    '-filter_complex', filters.join(';'), '-map', vOut, '-map', '[aout]', '-t', total.toFixed(3),
    '-c:v', 'libx264', ...x264, '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', o.outPath,
  );
  await runFfmpeg(args, { signal: o.signal, totalSec: total, onProgress: (f) => { void report(0.55 + f * 0.43, 'Encoding final video'); } });

  // 4. verify the output rather than trusting the exit code
  const p = await probe(o.outPath);
  if (!p.hasVideo || !p.hasAudio) throw new AppError('MEDIA_ERROR', 'Rendered file is missing a video or audio stream');
  if (p.durationSec == null || Math.abs(p.durationSec - t.durationSec) > 0.3) {
    throw new AppError('MEDIA_ERROR', `Rendered duration ${p.durationSec?.toFixed(2)}s does not match timeline ${t.durationSec.toFixed(2)}s`);
  }
  await report(1, 'Render verified');
  return { durationSec: p.durationSec, width: p.width ?? W, height: p.height ?? H };
}
