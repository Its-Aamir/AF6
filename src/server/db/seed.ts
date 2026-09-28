import type { RecipeConfig, Settings } from '../../shared/schemas';
import type { Db } from './client';
import { recipes, settings } from './schema';

export const DEFAULT_SETTINGS: Settings = {
  mock: { latencyMs: 2500, failureRate: 0, timeoutRate: 0, timeoutMs: 60_000 },
  defaultBudgetUsd: 25,
};

const mockDefaults = {
  image: { provider: 'mock', model: 'mock-image-standard' },
  video: { provider: 'mock', model: 'mock-video-standard' },
  tts: { provider: 'mock', model: 'mock-tts-v1' },
  music: { provider: 'mock', model: 'mock-music-v1' },
};

export const BUILT_IN_RECIPES: { slug: string; name: string; description: string; config: RecipeConfig }[] = [
  {
    slug: 'documentary-explainer',
    name: 'Documentary Explainer',
    description: 'Calm, authoritative long-form explainer with cinematic stills and occasional motion shots.',
    config: {
      aspectRatio: '16:9', targetDurationSec: 90, wordsPerMinute: 150, minSceneSec: 4, maxSceneSec: 9,
      tone: 'calm, authoritative, curious', audience: 'general audience',
      visualStyle: 'cinematic documentary photography, natural light, shallow depth of field, 35mm film grain',
      negativePrompt: 'text, watermark, logo, distorted hands, low quality',
      videoRatio: 0.3,
      structure: ['Hook', 'Context', 'The core story', 'Turning point', 'Takeaway'],
      defaults: mockDefaults, voiceId: 'mock-narrator-warm',
      captions: { enabled: true, maxChars: 42, position: 'bottom' },
      music: { enabled: true, mood: 'ambient cinematic', volume: 0.25 },
    },
  },
  {
    slug: 'history-mystery',
    name: 'History Mystery',
    description: 'Suspenseful storytelling about unsolved historical events. Moody, dramatic visuals.',
    config: {
      aspectRatio: '16:9', targetDurationSec: 120, wordsPerMinute: 140, minSceneSec: 4, maxSceneSec: 8,
      tone: 'suspenseful, dramatic, measured', audience: 'history enthusiasts',
      visualStyle: 'moody chiaroscuro lighting, archival texture, fog, desaturated teal and amber palette',
      negativePrompt: 'modern objects, text, watermark, cartoon',
      videoRatio: 0.4,
      structure: ['Cold open', 'The setting', 'What happened', 'The theories', 'What we know now'],
      defaults: mockDefaults, voiceId: 'mock-narrator-deep',
      captions: { enabled: true, maxChars: 40, position: 'bottom' },
      music: { enabled: true, mood: 'dark suspense', volume: 0.22 },
    },
  },
  {
    slug: 'faceless-shorts',
    name: 'Faceless Shorts (9:16)',
    description: 'Fast-paced vertical short with punchy captions and high visual turnover.',
    config: {
      aspectRatio: '9:16', targetDurationSec: 45, wordsPerMinute: 175, minSceneSec: 2, maxSceneSec: 4,
      tone: 'energetic, punchy, direct', audience: 'mobile viewers',
      visualStyle: 'bold high-contrast vertical composition, vivid colour, dynamic framing',
      negativePrompt: 'text, watermark, blurry',
      videoRatio: 0.5,
      structure: ['Hook', 'Three fast facts', 'Payoff', 'Call to action'],
      defaults: mockDefaults, voiceId: 'mock-narrator-bright',
      captions: { enabled: true, maxChars: 24, position: 'center' },
      music: { enabled: true, mood: 'upbeat electronic', volume: 0.3 },
    },
  },
  {
    slug: 'tech-news-brief',
    name: 'Tech News Brief',
    description: 'Clean, modern news-style brief with product-style visuals and title cards.',
    config: {
      aspectRatio: '16:9', targetDurationSec: 60, wordsPerMinute: 160, minSceneSec: 3, maxSceneSec: 7,
      tone: 'clear, neutral, informed', audience: 'tech-savvy professionals',
      visualStyle: 'clean studio product photography, soft gradients, modern minimal aesthetic',
      negativePrompt: 'clutter, text, watermark',
      videoRatio: 0.2,
      structure: ['Headline', 'What happened', 'Why it matters', 'What to watch next'],
      defaults: mockDefaults, voiceId: 'mock-narrator-warm',
      captions: { enabled: true, maxChars: 42, position: 'bottom' },
      music: { enabled: true, mood: 'light corporate pulse', volume: 0.2 },
    },
  },
];

/** Idempotent: inserts built-ins and default settings if missing; never overwrites user edits. */
export async function seed(db: Db): Promise<void> {
  for (const r of BUILT_IN_RECIPES) {
    await db.insert(recipes).values({ ...r, builtIn: true }).onConflictDoNothing({ target: recipes.slug });
  }
  await db.insert(settings).values({ key: 'app', value: DEFAULT_SETTINGS }).onConflictDoNothing({ target: settings.key });
}
