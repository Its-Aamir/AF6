/**
 * Deterministic PCM WAV synthesis (used by the mock TTS and mock music providers).
 * Pure Node — no external binaries — so timing is exact and testable.
 */
export const SAMPLE_RATE = 22050;

export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export interface VoiceProfile { basePitch: number; wordsPerMinuteFactor: number }

export interface SpeechTiming { word: string; start: number; end: number }

/**
 * Compute word timings for a text at a speaking rate, with punctuation pauses.
 * Deterministic: same text + rate → same timings.
 */
export function planSpeech(text: string, wordsPerMinute: number): { words: SpeechTiming[]; durationSec: number } {
  const tokens = text.split(/\s+/).map((w) => w.trim()).filter(Boolean);
  const avgWordSec = 60 / wordsPerMinute;
  const lead = 0.25;
  let t = lead;
  const words: SpeechTiming[] = [];
  for (const w of tokens) {
    const letters = w.replace(/[^\p{L}\p{N}]/gu, '').length || 1;
    const dur = Math.max(0.12, avgWordSec * (0.55 + Math.min(letters, 12) / 12) * 0.78);
    words.push({ word: w, start: round3(t), end: round3(t + dur) });
    t += dur;
    if (/[.!?]["')\]]*$/.test(w)) t += avgWordSec * 0.9;
    else if (/[,;:—–-]["')\]]*$/.test(w)) t += avgWordSec * 0.4;
    else t += avgWordSec * 0.08;
  }
  const durationSec = round3(t + 0.35);
  return { words, durationSec };
}

/** Render speech-like tones for the timings (one syllabic tone burst per word). */
export function synthesizeSpeech(words: SpeechTiming[], durationSec: number, voice: VoiceProfile, sampleRate = SAMPLE_RATE): Float32Array {
  const out = new Float32Array(Math.ceil(durationSec * sampleRate));
  for (const [i, w] of words.entries()) {
    const s0 = Math.floor(w.start * sampleRate);
    const s1 = Math.min(out.length, Math.floor(w.end * sampleRate));
    const pitch = voice.basePitch * (1 + 0.08 * Math.sin(i * 1.7)) ;
    const n = s1 - s0;
    for (let s = 0; s < n; s++) {
      const tt = s / sampleRate;
      const env = Math.sin((Math.PI * s) / n) ** 0.6;
      const v = Math.sin(2 * Math.PI * pitch * tt) * 0.5 + Math.sin(2 * Math.PI * pitch * 2.01 * tt) * 0.2 + Math.sin(2 * Math.PI * pitch * 3.02 * tt) * 0.08;
      out[s0 + s] += v * env * 0.45;
    }
  }
  return out;
}

/** Simple ambient chord-pad "music" bed. */
export function synthesizeMusic(durationSec: number, seed: number, sampleRate = SAMPLE_RATE): Float32Array {
  const r = rng(seed);
  const roots = [110, 123.47, 130.81, 146.83, 164.81];
  const root = roots[Math.floor(r() * roots.length)];
  const progression = [0, 5, 3, 4].map((deg) => root * 2 ** ([0, 2, 4, 5, 7, 9][deg] / 12));
  const barSec = 4;
  const out = new Float32Array(Math.ceil(durationSec * sampleRate));
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    const bar = Math.floor(t / barSec) % progression.length;
    const f = progression[bar];
    const local = (t % barSec) / barSec;
    const env = Math.min(1, local * 8) * (1 - local * 0.3);
    let v = 0;
    for (const mult of [1, 1.25, 1.5, 2]) v += Math.sin(2 * Math.PI * f * mult * t) * (mult === 1 ? 0.3 : 0.15);
    const fadeIn = Math.min(1, t / 1.5);
    const fadeOut = Math.min(1, (durationSec - t) / 2);
    out[i] = v * env * 0.5 * fadeIn * Math.max(0, fadeOut);
  }
  return out;
}

function round3(n: number) { return Math.round(n * 1000) / 1000; }
