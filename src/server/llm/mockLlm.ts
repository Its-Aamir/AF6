/**
 * Mock LLM. Returns JSON *text* exactly like a real model would, which then goes
 * through the same extraction + strict validation path as any real provider.
 * Content is template-based and deterministic (seeded by input).
 *
 * Test hooks in topic/script text:
 *   [mock:invalid-json]   first answer is malformed, repair round succeeds
 *   [mock:invalid-always] every answer is malformed → LLM_OUTPUT_INVALID
 */
import { hashString, rng } from '../media/wav';
import type { LlmProvider, LlmRequest, LlmResponse } from '../providers/types';

const OPENERS = [
  'What if everything you thought you knew about {t} was only half the story?',
  'Few stories capture the imagination quite like {t}.',
  'This is the story of {t}, and it is stranger than it first appears.',
];
const BODY = [
  'To understand {t}, we have to go back to where it all began.',
  'At first glance it seems simple, but the details tell a much richer story.',
  'Researchers have spent years piecing together what really happened.',
  'Every clue points to something bigger than anyone expected.',
  'The evidence is scattered across archives, landscapes and memories.',
  'What changed everything was a single, overlooked detail.',
  'The more closely you look, the stranger it becomes.',
  'Some answers came quickly, while others took generations.',
  'Behind the headlines were ordinary people making extraordinary choices.',
  'Maps, letters and photographs slowly revealed a hidden pattern.',
  'It forced people to rethink assumptions that had seemed obvious.',
  'Not everyone agreed on what it meant, and the debate grew louder.',
  'The consequences rippled outward in ways no one could have predicted.',
  'Here is what we know, and what we still do not.',
];
const CLOSERS = [
  'Today, {t} is still studied, debated and retold.',
  'It is a reminder that history is rarely as tidy as we imagine.',
  'So the next time you hear about {t}, remember the full picture.',
  'If this story surprised you, stay tuned for the next one.',
];
const STOP = new Set('the a an and or but of to in on at for with from by as is was were are be been it its this that these those we our you your they their there here what which who whom when where why how into over under than then so not no only also just very more most much many some any each every one two three about after before because while'.split(' '));

function fill(s: string, topic: string) { return s.replaceAll('{t}', topic); }

function words(n: string) { return n.split(/\s+/).filter(Boolean).length; }

function genScript(ctx: Record<string, unknown>) {
  const topic = String(ctx.topic ?? 'this subject').replace(/\[mock:[a-z-]+\]/g, '').trim() || 'this subject';
  const recipe = ctx.recipe as { structure: string[]; targetDurationSec: number; wordsPerMinute: number };
  const r = rng(hashString(topic));
  const targetWords = Math.round((recipe.targetDurationSec * recipe.wordsPerMinute) / 60);
  const perSection = Math.max(12, Math.round(targetWords / recipe.structure.length));
  const pool = [...BODY];
  const sections = recipe.structure.map((heading, i) => {
    const sentences: string[] = [];
    if (i === 0) sentences.push(fill(OPENERS[Math.floor(r() * OPENERS.length)], topic));
    const isLast = i === recipe.structure.length - 1;
    while (words(sentences.join(' ')) < perSection - (isLast ? 10 : 0)) {
      if (!pool.length) pool.push(...BODY);
      sentences.push(fill(pool.splice(Math.floor(r() * pool.length), 1)[0], topic));
    }
    if (isLast) sentences.push(fill(CLOSERS[Math.floor(r() * CLOSERS.length)], topic));
    return { heading, narration: sentences.join(' ') };
  });
  const title = topic.length > 3 ? `${topic.charAt(0).toUpperCase()}${topic.slice(1)}: The Untold Story` : 'Untitled Story';
  return {
    title: title.slice(0, 140),
    summary: `A ${recipe.structure.length}-part narrated video exploring ${topic}.`,
    hook: sections[0].narration.split(/(?<=[.!?])\s/)[0],
    sections,
  };
}

function analyze(ctx: Record<string, unknown>) {
  const paragraphs = (ctx.paragraphs as string[]) ?? [];
  const headingFor = (p: string, i: number) => {
    const kw = p.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, '')).filter((w) => w.length > 3 && !STOP.has(w.toLowerCase())).slice(0, 3);
    return kw.length ? `${i + 1}. ${kw.join(' ')}` : `Part ${i + 1}`;
  };
  const first = paragraphs[0] ?? 'Untitled';
  return {
    title: first.split(/(?<=[.!?])\s/)[0].slice(0, 80),
    summary: `User-provided script in ${paragraphs.length} part(s).`,
    sectionHeadings: paragraphs.map(headingFor),
  };
}

const CAMERAS = ['slow_push_in', 'pan_right', 'static', 'slow_pull_out', 'pan_left', 'tilt_up', 'orbit'] as const;
const SHOTS = ['wide', 'medium', 'close_up', 'aerial', 'insert', 'wide', 'extreme_close_up'] as const;

function plan(ctx: Record<string, unknown>) {
  const scenes = ctx.scenes as { index: number; narration: string }[];
  const recipe = ctx.recipe as { visualStyle: string; negativePrompt: string; videoRatio: number; tone: string };
  const topic = String(ctx.topic ?? '').replace(/\[mock:[a-z-]+\]/g, '').trim();
  const mood = recipe.tone.split(',')[0].trim() || 'neutral';
  return {
    styleNotes: `Consistent look: ${recipe.visualStyle}.`,
    scenes: scenes.map((s, i) => {
      const ratio = recipe.videoRatio;
      const useVideo = ratio > 0 && (i === 0 || Math.floor(i * ratio) !== Math.floor((i - 1) * ratio));
      const keywords = s.narration.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, '')).filter((w) => w.length > 3 && !STOP.has(w.toLowerCase())).slice(0, 6);
      const shot = SHOTS[i % SHOTS.length];
      const subject = keywords.length ? keywords.join(', ') : topic || 'the story';
      return {
        sceneIndex: s.index,
        strategy: useVideo ? 'ai_video' : 'ai_image',
        prompt: `${shot.replace('_', ' ')} shot evoking ${subject}${topic ? `, in the context of ${topic}` : ''}. ${recipe.visualStyle}`.slice(0, 1200),
        negativePrompt: recipe.negativePrompt,
        camera: CAMERAS[i % CAMERAS.length],
        shotType: shot,
        mood,
        onScreenText: null,
      };
    }),
  };
}

export class MockLlm implements LlmProvider {
  id = 'mock';
  model = 'mock-llm-v1';
  simulated = true;
  unitCostPer1kTokensUsd = 0.003;

  async complete(req: LlmRequest): Promise<LlmResponse> {
    await new Promise((r) => setTimeout(r, 300));
    if (req.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const marker = JSON.stringify(req.context);
    const invalid = marker.includes('[mock:invalid-always]') || (marker.includes('[mock:invalid-json]') && !req.repairErrors);
    let body: unknown;
    if (req.task === 'script.generate') body = genScript(req.context);
    else if (req.task === 'script.analyze') body = analyze(req.context);
    else body = plan(req.context);
    const text = invalid ? `Sure! Here is the result: {"title": 42, "oops": [unterminated` : JSON.stringify(body, null, 1);
    return { text, inputTokens: Math.ceil((req.system.length + req.prompt.length) / 4), outputTokens: Math.ceil(text.length / 4) };
  }
}

let llm: LlmProvider = new MockLlm();
export function getLlm(): LlmProvider { return llm; }
/** Test hook. */
export function setLlm(p: LlmProvider): void { llm = p; }
