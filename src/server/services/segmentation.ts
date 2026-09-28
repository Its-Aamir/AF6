/**
 * Deterministic narration → scene segmentation. The narration's measured word
 * timings are the master clock; scenes tile [0, narrationDuration] exactly.
 */
import type { WordTiming } from '../../shared/schemas';

export interface SegmentedScene { wordStart: number; wordEnd: number; start: number; end: number; text: string }

const SENTENCE_END = /[.!?]["')\]]*$/;
const CLAUSE_END = /[,;:—–]["')\]]*$/;

/** Boundary time between word i-1 and word i: middle of the pause between them. */
export function boundaryBefore(words: WordTiming[], i: number): number {
  if (i <= 0) return 0;
  if (i >= words.length) return Number.POSITIVE_INFINITY;
  return round3((words[i - 1].end + words[i].start) / 2);
}

function spanDur(words: WordTiming[], a: number, b: number): number {
  return words[b - 1].end - words[a].start;
}

/** Split word range [a,b) into units no longer than maxSec, preferring clause breaks. */
function splitLong(words: WordTiming[], a: number, b: number, maxSec: number): [number, number][] {
  if (spanDur(words, a, b) <= maxSec || b - a <= 1) return [[a, b]];
  // Choose a split point near the middle, preferring clause punctuation.
  let best = -1;
  let bestScore = Infinity;
  const mid = (words[a].start + words[b - 1].end) / 2;
  for (let i = a + 1; i < b; i++) {
    const t = boundaryBefore(words, i);
    const score = Math.abs(t - mid) - (CLAUSE_END.test(words[i - 1].word) ? maxSec * 0.25 : 0);
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return [...splitLong(words, a, best, maxSec), ...splitLong(words, best, b, maxSec)];
}

export function segmentNarration(words: WordTiming[], durationSec: number, minSec: number, maxSec: number): SegmentedScene[] {
  if (!words.length) throw new Error('Cannot segment empty narration');
  // 1. sentences
  const sentences: [number, number][] = [];
  let s = 0;
  for (let i = 0; i < words.length; i++) {
    if (SENTENCE_END.test(words[i].word) || i === words.length - 1) { sentences.push([s, i + 1]); s = i + 1; }
  }
  // 2. units no longer than maxSec
  const units = sentences.flatMap(([a, b]) => splitLong(words, a, b, maxSec));
  // 3. greedy grouping within [minSec, maxSec]
  const groups: [number, number][] = [];
  let cur: [number, number] | null = null;
  for (const u of units) {
    if (!cur) { cur = [...u]; continue; }
    const curDur = spanDur(words, cur[0], cur[1]);
    const merged = spanDur(words, cur[0], u[1]);
    if (merged <= maxSec * 0.85 || (curDur < minSec && merged <= maxSec)) { cur[1] = u[1]; continue; }
    if (curDur < minSec) {
      // Too short to stand alone and too long to merge forward: fold into the previous scene if it fits.
      const prev = groups[groups.length - 1];
      if (prev && spanDur(words, prev[0], cur[1]) <= maxSec) prev[1] = cur[1];
      else groups.push(cur);
    } else groups.push(cur);
    cur = [...u];
  }
  if (cur) groups.push(cur);
  // 4. a too-short tail merges back if it keeps the previous scene reasonable
  if (groups.length > 1) {
    const last = groups[groups.length - 1];
    const prev = groups[groups.length - 2];
    if (spanDur(words, last[0], last[1]) < minSec && spanDur(words, prev[0], last[1]) <= maxSec * 1.25) {
      prev[1] = last[1];
      groups.pop();
    }
  }
  // 5. time tiling
  return groups.map(([a, b], idx) => ({
    wordStart: a,
    wordEnd: b,
    start: idx === 0 ? 0 : boundaryBefore(words, a),
    end: idx === groups.length - 1 ? round3(durationSec) : boundaryBefore(words, b),
    text: words.slice(a, b).map((w) => w.word).join(' '),
  }));
}

export interface SceneSpan { wordStart: number; wordEnd: number; start: number; end: number }

/**
 * Change a scene's duration by moving the boundary it shares with a neighbour
 * (the next scene, or the previous one for the last scene), snapped to word
 * boundaries. Returns the updated [scene, neighbour] spans, or throws if impossible.
 */
export function adjustSceneDuration(
  words: WordTiming[], durationSec: number, target: SceneSpan, neighbour: SceneSpan, neighbourIsNext: boolean, requestedSec: number,
): { scene: SceneSpan; neighbour: SceneSpan } {
  let best: { scene: SceneSpan; neighbour: SceneSpan; diff: number } | null = null;
  if (neighbourIsNext) {
    // boundary word index b in (target.wordStart, neighbour.wordEnd)
    for (let b = target.wordStart + 1; b < neighbour.wordEnd; b++) {
      const t = boundaryBefore(words, b);
      const diff = Math.abs(t - target.start - requestedSec);
      if (!best || diff < best.diff) {
        best = {
          scene: { ...target, wordEnd: b, end: t },
          neighbour: { ...neighbour, wordStart: b, start: t, end: neighbour.end },
          diff,
        };
      }
    }
  } else {
    for (let b = neighbour.wordStart + 1; b < target.wordEnd; b++) {
      const t = boundaryBefore(words, b);
      const diff = Math.abs(target.end - t - requestedSec);
      if (!best || diff < best.diff) {
        best = {
          scene: { ...target, wordStart: b, start: t },
          neighbour: { ...neighbour, wordEnd: b, end: t },
          diff,
        };
      }
    }
  }
  if (!best) throw new Error('Scene duration cannot change: not enough words to move');
  void durationSec;
  return { scene: best.scene, neighbour: best.neighbour };
}

export function wordsText(words: WordTiming[], a: number, b: number): string {
  return words.slice(a, b).map((w) => w.word).join(' ');
}

/** Rescale provider word timings to the measured audio duration if they drift. */
export function reconcileTimings(words: WordTiming[], providerDuration: number, measuredDuration: number): WordTiming[] {
  if (!providerDuration || Math.abs(providerDuration - measuredDuration) / measuredDuration < 0.01) return words;
  const k = measuredDuration / providerDuration;
  return words.map((w) => ({ word: w.word, start: round3(w.start * k), end: round3(Math.min(measuredDuration, w.end * k)) }));
}

function round3(n: number) { return Math.round(n * 1000) / 1000; }
