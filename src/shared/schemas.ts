/**
 * Shared, strict schemas. Imported by the API, the worker and the web client.
 * Anything produced by an LLM MUST be validated against one of these before use.
 */
import { z } from 'zod';

// ── Enums ────────────────────────────────────────────────────────────────────

export const CAPABILITIES = ['image', 'video', 'tts', 'music'] as const;
export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof CapabilitySchema>;

export const VISUAL_STRATEGIES = ['ai_video', 'ai_image'] as const;
export const VisualStrategySchema = z.enum(VISUAL_STRATEGIES);
export type VisualStrategy = z.infer<typeof VisualStrategySchema>;

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1'] as const;
export const AspectRatioSchema = z.enum(ASPECT_RATIOS);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

export const PROJECT_STATUSES = [
  'draft', 'scripting', 'scripted', 'narrating', 'narrated', 'segmenting', 'segmented',
  'planning', 'planned', 'producing', 'assets_ready', 'assembled', 'qa_running',
  'qa_passed', 'qa_failed', 'rendering', 'rendered',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const SCENE_STATUSES = ['pending', 'planned', 'queued', 'generating', 'generated', 'failed'] as const;
export type SceneStatus = (typeof SCENE_STATUSES)[number];

export const QUALITY_STATUSES = ['unchecked', 'pass', 'warn', 'fail'] as const;
export type QualityStatus = (typeof QUALITY_STATUSES)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const GENERATION_STATUSES = ['pending', 'submitted', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled'] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export const ASSET_KINDS = ['image', 'video', 'narration', 'music', 'upload', 'render', 'package', 'voice_preview'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const MEDIA_TYPES = ['image', 'video', 'audio', 'archive'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const JOB_TYPES = [
  'script.generate', 'narration.generate', 'scenes.segment', 'visuals.plan',
  'scene.generate', 'music.generate', 'qa.run', 'narration.align', 'project.autopilot', 'render.final', 'package.export', 'voice.preview',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

// ── Channel Recipes ──────────────────────────────────────────────────────────

export const ProviderModelRefSchema = z.strictObject({
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
});
export type ProviderModelRef = z.infer<typeof ProviderModelRefSchema>;

export const RecipeConfigSchema = z.strictObject({
  aspectRatio: AspectRatioSchema,
  targetDurationSec: z.number().int().min(15).max(3600),
  wordsPerMinute: z.number().int().min(90).max(220),
  minSceneSec: z.number().min(1.5).max(30),
  maxSceneSec: z.number().min(2).max(60),
  tone: z.string().min(1).max(200),
  audience: z.string().max(200).default(''),
  visualStyle: z.string().min(1).max(500),
  negativePrompt: z.string().max(500).default(''),
  /** Fraction (0..1) of scenes that should use ai_video; the rest ai_image. */
  videoRatio: z.number().min(0).max(1),
  structure: z.array(z.string().min(1).max(80)).min(1).max(12),
  defaults: z.strictObject({
    image: ProviderModelRefSchema,
    video: ProviderModelRefSchema,
    tts: ProviderModelRefSchema,
    music: ProviderModelRefSchema,
  }),
  voiceId: z.string().min(1).max(128),
  captions: z.strictObject({
    enabled: z.boolean(),
    maxChars: z.number().int().min(12).max(80),
    position: z.enum(['bottom', 'center']),
  }),
  music: z.strictObject({
    enabled: z.boolean(),
    mood: z.string().max(80),
    volume: z.number().min(0).max(1),
  }),
}).refine((r) => r.maxSceneSec > r.minSceneSec, { message: 'maxSceneSec must be greater than minSceneSec', path: ['maxSceneSec'] });
export type RecipeConfig = z.infer<typeof RecipeConfigSchema>;

export const RecipeInputSchema = z.strictObject({
  name: z.string().trim().min(2).max(80),
  description: z.string().max(400).default(''),
  config: RecipeConfigSchema,
});

// ── Script (LLM output — strict) ─────────────────────────────────────────────

export const ScriptSectionSchema = z.strictObject({
  heading: z.string().min(1).max(120),
  narration: z.string().min(1).max(8000),
});
export const ScriptSchema = z.strictObject({
  title: z.string().min(1).max(140),
  summary: z.string().min(1).max(600),
  hook: z.string().min(1).max(600),
  sections: z.array(ScriptSectionSchema).min(1).max(40),
});
export type Script = z.infer<typeof ScriptSchema>;

/** Script analysis for user-provided scripts: the LLM only labels, never rewrites. */
export const ScriptAnalysisSchema = z.strictObject({
  title: z.string().min(1).max(140),
  summary: z.string().min(1).max(600),
  sectionHeadings: z.array(z.string().min(1).max(120)).min(1).max(40),
});
export type ScriptAnalysis = z.infer<typeof ScriptAnalysisSchema>;

// ── Visual plan (LLM output — strict) ────────────────────────────────────────

export const CAMERA_MOTIONS = ['static', 'slow_push_in', 'slow_pull_out', 'pan_left', 'pan_right', 'tilt_up', 'orbit', 'handheld'] as const;
export const SceneBriefSchema = z.strictObject({
  sceneIndex: z.number().int().min(1),
  strategy: VisualStrategySchema,
  prompt: z.string().min(8).max(1200),
  negativePrompt: z.string().max(500),
  camera: z.enum(CAMERA_MOTIONS),
  shotType: z.enum(['wide', 'medium', 'close_up', 'extreme_close_up', 'aerial', 'insert']),
  mood: z.string().min(1).max(80),
  onScreenText: z.string().max(80).nullable(),
});
export type SceneBrief = z.infer<typeof SceneBriefSchema>;
export const VisualPlanSchema = z.strictObject({
  styleNotes: z.string().max(600),
  scenes: z.array(SceneBriefSchema).min(1).max(400),
});
export type VisualPlan = z.infer<typeof VisualPlanSchema>;

// ── Narration timing / captions / timeline ───────────────────────────────────

export const WordTimingSchema = z.strictObject({
  word: z.string(),
  start: z.number().min(0),
  end: z.number().min(0),
});
export type WordTiming = z.infer<typeof WordTimingSchema>;

export const CaptionCueSchema = z.strictObject({
  start: z.number().min(0),
  end: z.number().min(0),
  text: z.string().min(1).max(200),
});
export type CaptionCue = z.infer<typeof CaptionCueSchema>;

export const CaptionsSchema = z.strictObject({
  enabled: z.boolean(),
  position: z.enum(['bottom', 'center']),
  maxChars: z.number().int(),
  cues: z.array(CaptionCueSchema),
  generatedAt: z.string().nullable(),
});
export type Captions = z.infer<typeof CaptionsSchema>;

export const MusicSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  mood: z.string().max(80),
  volume: z.number().min(0).max(1),
  duck: z.boolean(),
});
export type MusicSettings = z.infer<typeof MusicSettingsSchema>;

export const TimelineClipSchema = z.strictObject({
  sceneId: z.string(),
  index: z.number().int(),
  start: z.number(),
  end: z.number(),
  assetId: z.string(),
  mediaKind: z.enum(['image', 'video']),
  motion: z.enum(CAMERA_MOTIONS),
});
export type TimelineClip = z.infer<typeof TimelineClipSchema>;

export const TimelineSchema = z.strictObject({
  version: z.literal(1),
  durationSec: z.number().positive(),
  width: z.number().int(),
  height: z.number().int(),
  fps: z.number().int(),
  video: z.array(TimelineClipSchema).min(1),
  narration: z.strictObject({ assetId: z.string(), start: z.literal(0), end: z.number() }),
  music: z.strictObject({ assetId: z.string(), volume: z.number(), duck: z.boolean() }).nullable(),
  captions: z.strictObject({ position: z.enum(['bottom', 'center']), cues: z.array(CaptionCueSchema) }).nullable(),
  assembledAt: z.string(),
});
export type Timeline = z.infer<typeof TimelineSchema>;

// ── QA ───────────────────────────────────────────────────────────────────────

export const QaCheckSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pass', 'warn', 'fail']),
  message: z.string(),
  sceneId: z.string().nullable(),
});
export type QaCheck = z.infer<typeof QaCheckSchema>;
export const QaReportSchema = z.strictObject({
  passed: z.boolean(),
  checks: z.array(QaCheckSchema),
  ranAt: z.string(),
});
export type QaReport = z.infer<typeof QaReportSchema>;

// ── API inputs ───────────────────────────────────────────────────────────────

export const MAX_SCRIPT_CHARS = 20_000;

export const CreateProjectInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(140),
  inputMode: z.enum(['topic', 'script']),
  topic: z.string().trim().max(1000).default(''),
  sourceScript: z.string().max(MAX_SCRIPT_CHARS).default(''),
  recipeId: z.string().uuid(),
  budgetUsd: z.number().min(0).max(100_000).optional(),
  /** Optional overrides of the recipe's defaults: narration voice and visual models. */
  voiceId: z.string().min(1).max(160).optional(),
  imageModel: ProviderModelRefSchema.optional(),
  videoModel: ProviderModelRefSchema.optional(),
}).superRefine((v, ctx) => {
  if (v.inputMode === 'topic' && v.topic.trim().length < 3) ctx.addIssue({ code: 'custom', path: ['topic'], message: 'Enter a topic (at least 3 characters).' });
  if (v.inputMode === 'script' && v.sourceScript.trim().split(/\s+/).length < 10) ctx.addIssue({ code: 'custom', path: ['sourceScript'], message: 'Paste a script of at least 10 words.' });
});
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;

export const UpdateProjectInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(140).optional(),
  topic: z.string().trim().max(1000).optional(),
  budgetUsd: z.number().min(0).max(100_000).optional(),
  voiceId: z.string().min(1).max(128).optional(),
  music: MusicSettingsSchema.partial().optional(),
  captions: z.strictObject({ enabled: z.boolean().optional(), position: z.enum(['bottom', 'center']).optional(), maxChars: z.number().int().min(12).max(80).optional() }).optional(),
});

export const EditScriptInputSchema = z.strictObject({
  sections: z.array(z.strictObject({ heading: z.string().trim().min(1).max(120), narration: z.string().trim().min(1).max(8000) })).min(1).max(40),
  title: z.string().trim().min(1).max(140).optional(),
});

export const UpdateSceneInputSchema = z.strictObject({
  prompt: z.string().trim().min(8).max(1200).optional(),
  negativePrompt: z.string().max(500).optional(),
  visualStrategy: VisualStrategySchema.optional(),
  provider: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(128).optional(),
  references: z.array(z.string().max(300)).max(8).optional(),
  locked: z.boolean().optional(),
});

export const GenerateSceneInputSchema = z.strictObject({
  alternatives: z.number().int().min(1).max(4).default(1),
});

export const SceneDurationInputSchema = z.strictObject({ durationSec: z.number().positive().max(600) });
export const SelectAssetInputSchema = z.strictObject({ assetId: z.string().uuid() });
export const RenderInputSchema = z.strictObject({ preset: z.enum(['draft', 'final', 'hd']).default('final') });

export const MockSettingsSchema = z.strictObject({
  latencyMs: z.number().int().min(0).max(120_000),
  failureRate: z.number().min(0).max(1),
  timeoutRate: z.number().min(0).max(1),
  timeoutMs: z.number().int().min(1000).max(600_000),
});
export type MockSettings = z.infer<typeof MockSettingsSchema>;

export const SettingsSchema = z.strictObject({
  mock: MockSettingsSchema,
  defaultBudgetUsd: z.number().min(0).max(100_000),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const UpdateSettingsInputSchema = z.strictObject({
  mock: MockSettingsSchema.partial().optional(),
  defaultBudgetUsd: z.number().min(0).max(100_000).optional(),
});

/** Aspect ratio → render/generation resolution by preset. */
export function resolutionFor(aspect: AspectRatio, preset: 'draft' | 'final' | 'hd'): { width: number; height: number } {
  const long = preset === 'hd' ? 1920 : preset === 'final' ? 1280 : 640;
  const short = preset === 'hd' ? 1080 : preset === 'final' ? 720 : 360;
  if (aspect === '16:9') return { width: long, height: short };
  if (aspect === '9:16') return { width: short, height: long };
  return { width: short, height: short };
}

// ── Autopilot / render report ────────────────────────────────────────────────

export const AUTOPILOT_STEPS = ['script', 'narration', 'segment', 'plan', 'assets', 'captions', 'music', 'assemble', 'qa', 'render', 'package', 'done'] as const;
export type AutopilotStep = (typeof AUTOPILOT_STEPS)[number];

export interface AutopilotState {
  running: boolean;
  step: AutopilotStep;
  message: string;
  startedAt: string;
  finishedAt: string | null;
  jobId: string | null;
  attempts: Record<string, number>;
  fixRounds: number;
  error: string | null;
  preset: 'draft' | 'final' | 'hd';
  log: { at: string; message: string }[];
}

export interface RenderReportCheck { id: string; label: string; status: 'pass' | 'warn' | 'fail'; message: string }
export interface RenderReport {
  assetId: string;
  measuredAt: string;
  durationSec: number;
  width: number;
  height: number;
  integratedLufs: number | null;
  truePeakDb: number | null;
  blackSegments: { start: number; end: number }[];
  silentSegments: { start: number; end: number }[];
  simulatedContent: string[];
  publishReady: boolean;
  checks: RenderReportCheck[];
}
