/**
 * Align a known script to a recorded voiceover.
 *  - transcriptAlign: map transcription word timestamps onto the script words
 *    (global sequence alignment; unmatched words interpolated). Exact.
 *  - pauseAlign: no external service. Detects speech/silence with ffmpeg, anchors
 *    sentence/clause boundaries to the longer pauses, and distributes words over
 *    speech time by syllable weight. Accurate enough for scene cuts and captions.
 */
import { spawn } from 'node:child_process';
import type { WordTiming } from '../../shared/schemas';
import { config } from '../config';
import { AppError } from '../errors';

export function tokenizeScript(text: string): string[] {
  return text.split(/\s+/).map((w) => w.trim()).filter(Boolean);
}

const norm = (w: string) => w.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');

export function syllables(word: string): number {
  const w = norm(word);
  if (!w) return 1;
  if (/^\d+$/.test(w)) return Math.max(1, w.length); // numbers are spoken long
  const groups = w.match(/[aeiouyàáâäèéêëìíîïòóôöùúûü]+/g)?.length ?? 1;
  return Math.max(1, groups - (w.endsWith('e') && groups > 1 ? 1 : 0));
}

/** Relative spoken duration of a word: grows with letters (≈ phonemes) and syllables, plus a per-word floor. */
export function spokenWeight(word: string): number {
  const letters = norm(word).length || 1;
  return 0.5 + 0.11 * Math.min(letters, 14) + 0.2 * syllables(word);
}

// ── Transcript alignment ─────────────────────────────────────────────────────

export function transcriptAlign(script: string[], transcript: WordTiming[], durationSec: number): { words: WordTiming[]; matchRatio: number } {
  const n = script.length;
  const m = transcript.length;
  if (!n) return { words: [], matchRatio: 0 };
  const a = script.map(norm);
  const b = transcript.map((t) => norm(t.word));
  // Needleman–Wunsch with match=2, mismatch=-1, gap=-1 (Int32 DP; fine for scripts up to a few thousand words).
  const W = m + 1;
  const score = new Int32Array((n + 1) * W);
  const dir = new Uint8Array((n + 1) * W); // 1 diag, 2 up (script gap), 3 left (transcript gap)
  for (let i = 1; i <= n; i++) { score[i * W] = -i; dir[i * W] = 2; }
  for (let j = 1; j <= m; j++) { score[j] = -j; dir[j] = 3; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const d = score[(i - 1) * W + j - 1] + (a[i - 1] && a[i - 1] === b[j - 1] ? 2 : -1);
      const u = score[(i - 1) * W + j] - 1;
      const l = score[i * W + j - 1] - 1;
      const best = Math.max(d, u, l);
      score[i * W + j] = best;
      dir[i * W + j] = best === d ? 1 : best === u ? 2 : 3;
    }
  }
  const matched: (WordTiming | null)[] = new Array(n).fill(null);
  let i = n;
  let j = m;
  let hits = 0;
  while (i > 0 && j > 0) {
    const d = dir[i * W + j];
    if (d === 1) {
      if (a[i - 1] && a[i - 1] === b[j - 1]) { matched[i - 1] = transcript[j - 1]; hits++; }
      else matched[i - 1] = transcript[j - 1]; // substitution (misheard word) — keep its timing
      i--; j--;
    } else if (d === 2) i--;
    else j--;
  }
  // Interpolate unmatched script words between known neighbours.
  const out: WordTiming[] = [];
  let k = 0;
  while (k < n) {
    if (matched[k]) { out.push({ word: script[k], start: matched[k]!.start, end: matched[k]!.end }); k++; continue; }
    let e = k;
    while (e < n && !matched[e]) e++;
    const from = k > 0 ? out[k - 1].end : 0;
    const to = e < n ? matched[e]!.start : durationSec;
    const run = script.slice(k, e);
    const total = run.reduce((s, w) => s + spokenWeight(w), 0);
    let t = from;
    for (const w of run) {
      const d = ((to - from) * spokenWeight(w)) / total;
      out.push({ word: w, start: r3(t), end: r3(t + d) });
      t += d;
    }
    k = e;
  }
  return { words: monotonic(out, durationSec), matchRatio: hits / n };
}

// ── Pause-based alignment ────────────────────────────────────────────────────

export async function detectSilences(audioPath: string, noiseDb = -35, minSec = 0.2): Promise<{ start: number; end: number }[]> {
  const stderr = await ffmpegStderr(['-i', audioPath, '-af', `silencedetect=noise=${noiseDb}dB:d=${minSec}`, '-f', 'null', '-']);
  const out: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (const line of stderr.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) open = Math.max(0, Number(s[1]));
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && open !== null) { out.push({ start: open, end: Number(e[1]) }); open = null; }
  }
  if (open !== null) out.push({ start: open, end: Number.POSITIVE_INFINITY });
  return out;
}

export function pauseAlign(script: string[], silences: { start: number; end: number }[], durationSec: number): WordTiming[] {
  const n = script.length;
  if (!n) return [];
  const sil = silences.map((s) => ({ start: Math.max(0, s.start), end: Math.min(durationSec, s.end) })).filter((s) => s.end > s.start);
  // Speech segments = complement of silences.
  const speech: { start: number; end: number }[] = [];
  let t = 0;
  for (const s of sil) { if (s.start > t + 0.02) speech.push({ start: t, end: s.start }); t = Math.max(t, s.end); }
  if (durationSec > t + 0.02) speech.push({ start: t, end: durationSec });
  if (!speech.length) throw new AppError('MEDIA_ERROR', 'No speech detected in the voiceover.', { retryable: false });
  const totalSpeech = speech.reduce((s, x) => s + (x.end - x.start), 0);
  // speech-time (0..totalSpeech) → real time
  const toReal = (st: number) => {
    let acc = 0;
    for (const s of speech) {
      const d = s.end - s.start;
      if (st <= acc + d + 1e-9) return s.start + (st - acc);
      acc += d;
    }
    return speech[speech.length - 1].end;
  };
  const speechBefore = (real: number) => speech.reduce((s, x) => s + Math.max(0, Math.min(real, x.end) - x.start), 0);

  const weights = script.map(spokenWeight);
  const cum = [0];
  for (const w of weights) cum.push(cum[cum.length - 1] + w);
  const total = cum[n];

  // Anchor clause/sentence boundaries to longer pauses (monotonic, nearest in weight-fraction).
  const candidates = script.map((w, idx) => ({ idx: idx + 1, f: cum[idx + 1] / total, strong: /[.!?]["')\]]*$/.test(w) }))
    .filter((c) => c.idx < n && (c.strong || /[,;:—–]["')\]]*$/.test(script[c.idx - 1])));
  const longPauses = sil.filter((s) => s.end - s.start >= 0.3 && s.start > 0.05 && s.end < durationSec - 0.05);
  const anchors: { idx: number; st: number }[] = [];
  let ci = 0;
  for (const p of longPauses) {
    const g = speechBefore(p.start) / totalSpeech;
    let best = -1;
    let bestD = Infinity;
    for (let k = ci; k < candidates.length; k++) {
      const d = Math.abs(candidates[k].f - g) - (candidates[k].strong ? 0.01 : 0);
      if (d < bestD) { bestD = d; best = k; }
      if (candidates[k].f > g + 0.1) break;
    }
    if (best >= 0 && bestD < 0.06) { anchors.push({ idx: candidates[best].idx, st: speechBefore(p.start) }); ci = best + 1; }
  }
  // Distribute each chunk of words over its speech-time span by syllable weight.
  const bounds = [{ idx: 0, st: 0 }, ...anchors, { idx: n, st: totalSpeech }];
  const out: WordTiming[] = [];
  for (let b = 0; b < bounds.length - 1; b++) {
    const { idx: i0, st: s0 } = bounds[b];
    const { idx: i1, st: s1 } = bounds[b + 1];
    const w = cum[i1] - cum[i0] || 1;
    for (let k = i0; k < i1; k++) {
      const a0 = s0 + ((s1 - s0) * (cum[k] - cum[i0])) / w;
      const a1 = s0 + ((s1 - s0) * (cum[k + 1] - cum[i0])) / w;
      let start = toReal(a0 + 1e-6);
      let end = toReal(a1 - 1e-6);
      if (end < start) end = start;
      out.push({ word: script[k], start: r3(start), end: r3(end) });
    }
  }
  return monotonic(out, durationSec);
}

function monotonic(words: WordTiming[], durationSec: number): WordTiming[] {
  let last = 0;
  return words.map((w) => {
    const start = Math.min(durationSec, Math.max(last, w.start));
    const end = Math.min(durationSec, Math.max(start + 0.01, w.end));
    last = start;
    return { word: w.word, start: r3(start), end: r3(end) };
  });
}

function ffmpegStderr(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, ['-hide_banner', '-nostdin', '-nostats', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (b: Buffer) => { err += b.toString(); if (err.length > 5_000_000) err = err.slice(-2_000_000); });
    child.on('error', (e) => reject(new AppError('MEDIA_ERROR', `ffmpeg failed to start: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve(err) : reject(new AppError('MEDIA_ERROR', `ffmpeg analysis failed (${code}): ${err.slice(-300)}`))));
  });
}
export { ffmpegStderr };

function r3(n: number) { return Math.round(n * 1000) / 1000; }
