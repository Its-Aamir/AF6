import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../src/server/config';
import { encodeWav, planSpeech, synthesizeSpeech } from '../src/server/media/wav';
import { detectSilences, pauseAlign, tokenizeScript, transcriptAlign } from '../src/server/services/alignment';

const SCRIPT = `Hydrothermal vents were discovered in 1977. Nobody expected to find life there, in total darkness.
Yet the water around them was crowded with giant tube worms, pale crabs and shrimp. The food chain starts with bacteria, which turn chemicals into energy.
Some scientists think life on Earth may have begun in places exactly like this.`;

describe('voiceover alignment', () => {
  const plan = planSpeech(SCRIPT, 150);
  const words = tokenizeScript(SCRIPT);

  it('transcript alignment maps exact timings and tolerates misheard/missing words', () => {
    const transcript = plan.words.map((w) => ({ ...w }));
    transcript[3] = { ...transcript[3], word: 'nineteen-seventy-seven' }; // misheard
    transcript.splice(10, 1); // dropped word
    const r = transcriptAlign(words, transcript, plan.durationSec);
    expect(r.words).toHaveLength(words.length);
    expect(r.matchRatio).toBeGreaterThan(0.9);
    const err = r.words.map((w, i) => Math.abs(w.start - plan.words[i].start));
    expect(Math.max(...err)).toBeLessThan(0.5);
    expect(err.filter((e) => e > 0.01).length).toBeLessThan(4);
    for (let i = 1; i < r.words.length; i++) expect(r.words[i].start).toBeGreaterThanOrEqual(r.words[i - 1].start);
  });

  it('pause-based alignment (no external service) lands words close to the truth', async () => {
    const dir = path.join(config.storageDir, '..', 'align-test');
    await fs.mkdir(dir, { recursive: true });
    const wav = path.join(dir, 'vo.wav');
    await fs.writeFile(wav, encodeWav(synthesizeSpeech(plan.words, plan.durationSec, { basePitch: 150, wordsPerMinuteFactor: 1 })));
    const silences = await detectSilences(wav);
    expect(silences.length).toBeGreaterThan(5);
    const aligned = pauseAlign(words, silences, plan.durationSec);
    expect(aligned).toHaveLength(words.length);
    const errs = aligned.map((w, i) => Math.abs(w.start - plan.words[i].start));
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    expect(mean).toBeLessThan(0.35);
    // Sentence starts (where scenes and captions cut) are anchored to pauses.
    const sentenceStarts = words.map((w, i) => (i > 0 && /[.!?]$/.test(words[i - 1]) ? i : -1)).filter((i) => i > 0);
    for (const i of sentenceStarts) expect(Math.abs(aligned[i].start - plan.words[i].start)).toBeLessThan(0.4);
  });
});
