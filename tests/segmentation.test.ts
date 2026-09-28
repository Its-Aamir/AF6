import { describe, expect, it } from 'vitest';
import { planSpeech } from '../src/server/media/wav';
import { buildCaptionCues, toAss, toSrt } from '../src/server/services/captions';
import { adjustSceneDuration, reconcileTimings, segmentNarration } from '../src/server/services/segmentation';

const TEXT = 'The library of Alexandria was one of the largest of the ancient world. Scholars travelled from far away to study there. ' +
  'Its collection grew for centuries, fed by an ambitious policy of copying every book that arrived in the harbour, including long treatises on astronomy, medicine, mathematics and poetry. ' +
  'Then, slowly, it declined. Nobody agrees on exactly when. What survives is mostly legend.';

describe('narration timing', () => {
  it('produces monotonic word timings deterministically', () => {
    const a = planSpeech(TEXT, 150);
    const b = planSpeech(TEXT, 150);
    expect(a).toEqual(b);
    for (let i = 1; i < a.words.length; i++) expect(a.words[i].start).toBeGreaterThanOrEqual(a.words[i - 1].end);
    expect(a.durationSec).toBeGreaterThan(a.words.at(-1)!.end);
  });

  it('rescales timings to the measured duration', () => {
    const { words } = planSpeech(TEXT, 150);
    const last = words.at(-1)!.end;
    const scaled = reconcileTimings(words, last, last * 0.9);
    expect(scaled.at(-1)!.end).toBeCloseTo(last * 0.9, 2);
  });
});

describe('segmentation', () => {
  const { words, durationSec } = planSpeech(TEXT, 150);
  const scenes = segmentNarration(words, durationSec, 3, 7);

  it('tiles the full narration with no gaps', () => {
    expect(scenes[0].start).toBe(0);
    expect(scenes.at(-1)!.end).toBe(Math.round(durationSec * 1000) / 1000);
    for (let i = 1; i < scenes.length; i++) {
      expect(scenes[i].start).toBe(scenes[i - 1].end);
      expect(scenes[i].wordStart).toBe(scenes[i - 1].wordEnd);
    }
    expect(scenes.at(-1)!.wordEnd).toBe(words.length);
  });

  it('keeps scenes within bounds and splits long sentences', () => {
    for (const s of scenes) expect(s.end - s.start).toBeLessThanOrEqual(7 * 1.3);
    expect(scenes.length).toBeGreaterThan(3);
  });

  it('adjusts a scene duration by moving the shared boundary', () => {
    const [a, b] = scenes;
    const res = adjustSceneDuration(words, durationSec, a, b, true, a.end - a.start + 1.5);
    expect(res.scene.end).toBe(res.neighbour.start);
    expect(res.scene.end - res.scene.start).toBeGreaterThan(a.end - a.start);
    expect(res.neighbour.end).toBe(b.end);
    expect(res.scene.wordEnd).toBe(res.neighbour.wordStart);
  });

  it('adjusts the last scene against its previous neighbour', () => {
    const last = scenes.at(-1)!;
    const prev = scenes.at(-2)!;
    const res = adjustSceneDuration(words, durationSec, last, prev, false, last.end - last.start - 1);
    expect(res.scene.end).toBe(last.end);
    expect(res.scene.start).toBe(res.neighbour.end);
  });
});

describe('captions', () => {
  const { words } = planSpeech(TEXT, 150);
  const cues = buildCaptionCues(words, 32);
  it('respects max chars and ordering', () => {
    for (const c of cues) expect(c.text.length).toBeLessThanOrEqual(32 + 15);
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end - 1e-9);
    expect(cues.map((c) => c.text).join(' ')).toBe(words.map((w) => w.word).join(' '));
  });
  it('exports SRT and sanitised ASS', () => {
    expect(toSrt(cues)).toMatch(/^1\n00:00:00,\d{3} --> /);
    const ass = toAss([{ start: 0, end: 1, text: 'Hi {\\b1}there\\N' }], 1280, 720, 'bottom');
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Hi b1thereN');
  });
});
