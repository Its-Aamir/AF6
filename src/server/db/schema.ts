import { sql } from 'drizzle-orm';
import {
  boolean, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import type {
  AutopilotState, RenderReport,
  Captions, MusicSettings, QaReport, RecipeConfig, Script, SceneBrief, Timeline, WordTiming,
} from '../../shared/schemas';

const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const recipes = pgTable('recipes', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  builtIn: boolean('built_in').notNull().default(false),
  config: jsonb('config').$type<RecipeConfig>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const projects = pgTable('projects', {
  id: id(),
  title: text('title').notNull(),
  inputMode: text('input_mode').$type<'topic' | 'script'>().notNull(),
  topic: text('topic').notNull().default(''),
  sourceScript: text('source_script').notNull().default(''),
  recipeId: uuid('recipe_id').references(() => recipes.id, { onDelete: 'set null' }),
  recipeName: text('recipe_name').notNull(),
  recipeSnapshot: jsonb('recipe_snapshot').$type<RecipeConfig>().notNull(),
  status: text('status').notNull().default('draft'),
  /** Stable status to return to if the running step fails. */
  resumeStatus: text('resume_status'),
  script: jsonb('script').$type<Script>(),
  voiceId: text('voice_id').notNull(),
  narrationAssetId: uuid('narration_asset_id'),
  narrationDurationSec: doublePrecision('narration_duration_sec'),
  narrationWords: jsonb('narration_words').$type<WordTiming[]>(),
  narrationStale: boolean('narration_stale').notNull().default(false),
  /** User-supplied voiceover (uploaded). When set, narration = this audio aligned to the script (no TTS). */
  voiceoverAssetId: uuid('voiceover_asset_id'),
  /** How narration timings were obtained: provider TTS timestamps, transcription, or pause-based alignment. */
  narrationTimingSource: text('narration_timing_source'),
  autopilot: jsonb('autopilot').$type<AutopilotState>(),
  renderReport: jsonb('render_report').$type<RenderReport>(),
  visualStyleNotes: text('visual_style_notes'),
  music: jsonb('music').$type<MusicSettings>().notNull(),
  musicAssetId: uuid('music_asset_id'),
  captions: jsonb('captions').$type<Captions>().notNull(),
  timeline: jsonb('timeline').$type<Timeline>(),
  qaReport: jsonb('qa_report').$type<QaReport>(),
  finalRenderAssetId: uuid('final_render_asset_id'),
  packageAssetId: uuid('package_asset_id'),
  budgetUsd: doublePrecision('budget_usd').notNull(),
  lastError: text('last_error'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('projects_updated_idx').on(t.updatedAt)]);

export const scenes = pgTable('scenes', {
  id: id(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  index: integer('index').notNull(),
  startSec: doublePrecision('start_sec').notNull(),
  endSec: doublePrecision('end_sec').notNull(),
  wordStart: integer('word_start').notNull(),
  wordEnd: integer('word_end').notNull(), // exclusive
  narration: text('narration').notNull(),
  status: text('status').notNull().default('pending'),
  visualStrategy: text('visual_strategy'),
  brief: jsonb('brief').$type<SceneBrief>(),
  prompt: text('prompt'),
  negativePrompt: text('negative_prompt').notNull().default(''),
  provider: text('provider'),
  model: text('model'),
  references: jsonb('references').$type<string[]>().notNull().default([]),
  locked: boolean('locked').notNull().default(false),
  selectedAssetId: uuid('selected_asset_id'),
  qualityStatus: text('quality_status').notNull().default('unchecked'),
  qualityNotes: text('quality_notes'),
  error: text('error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('scenes_project_index_uq').on(t.projectId, t.index)]);

export const assets = pgTable('assets', {
  id: id(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  sceneId: uuid('scene_id').references(() => scenes.id, { onDelete: 'set null' }),
  generationId: uuid('generation_id'),
  kind: text('kind').notNull(),
  mediaType: text('media_type').$type<'image' | 'video' | 'audio' | 'archive'>().notNull(),
  source: text('source').$type<'generated' | 'uploaded' | 'rendered'>().notNull(),
  label: text('label').notNull().default(''),
  storageKey: text('storage_key').notNull(),
  mime: text('mime').notNull(),
  bytes: integer('bytes').notNull(),
  durationSec: doublePrecision('duration_sec'),
  width: integer('width'),
  height: integer('height'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index('assets_project_idx').on(t.projectId), index('assets_scene_idx').on(t.sceneId)]);

export const generations = pgTable('generations', {
  id: id(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  sceneId: uuid('scene_id').references(() => scenes.id, { onDelete: 'set null' }),
  jobId: uuid('job_id'),
  capability: text('capability').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  prompt: text('prompt').notNull(),
  params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').notNull().default('pending'),
  externalId: text('external_id'),
  progress: doublePrecision('progress').notNull().default(0),
  submitAttempts: integer('submit_attempts').notNull().default(0),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }),
  outputAssetId: uuid('output_asset_id'),
  estimatedCostUsd: doublePrecision('estimated_cost_usd').notNull().default(0),
  actualCostUsd: doublePrecision('actual_cost_usd'),
  error: text('error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('generations_scene_idx').on(t.sceneId), index('generations_project_idx').on(t.projectId)]);

export const jobs = pgTable('jobs', {
  id: id(),
  type: text('type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  status: text('status').notNull().default('queued'),
  priority: integer('priority').notNull().default(0),
  runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  timeoutMs: integer('timeout_ms').notNull().default(120_000),
  lockedBy: text('locked_by'),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  progress: doublePrecision('progress').notNull().default(0),
  progressMessage: text('progress_message'),
  error: text('error'),
  errorCode: text('error_code'),
  result: jsonb('result').$type<Record<string, unknown>>(),
  dedupeKey: text('dedupe_key'),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  sceneId: uuid('scene_id').references(() => scenes.id, { onDelete: 'set null' }),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('jobs_claim_idx').on(t.status, t.runAt),
  index('jobs_project_idx').on(t.projectId),
  uniqueIndex('jobs_active_dedupe_uq').on(t.dedupeKey).where(sql`status in ('queued','running') and dedupe_key is not null`),
]);

export const costEntries = pgTable('cost_entries', {
  id: id(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  sceneId: uuid('scene_id').references(() => scenes.id, { onDelete: 'set null' }),
  generationId: uuid('generation_id').references(() => generations.id, { onDelete: 'set null' }),
  kind: text('kind').$type<'estimate' | 'actual'>().notNull(),
  capability: text('capability').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  units: doublePrecision('units').notNull(),
  unit: text('unit').notNull(),
  unitCostUsd: doublePrecision('unit_cost_usd').notNull(),
  amountUsd: doublePrecision('amount_usd').notNull(),
  simulated: boolean('simulated').notNull(),
  createdAt: createdAt(),
}, (t) => [index('cost_project_idx').on(t.projectId)]);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});

/** The mock provider's "remote side": lets simulated async tasks survive worker restarts. */
export const mockProviderTasks = pgTable('mock_provider_tasks', {
  id: id(),
  capability: text('capability').notNull(),
  model: text('model').notNull(),
  request: jsonb('request').$type<Record<string, unknown>>().notNull(),
  outcome: text('outcome').$type<'success' | 'failure' | 'timeout'>().notNull(),
  durationMs: integer('duration_ms').notNull(),
  outputKey: text('output_key'),
  outputMeta: jsonb('output_meta').$type<Record<string, unknown>>(),
  cancelled: boolean('cancelled').notNull().default(false),
  createdAt: createdAt(),
});

export type ProjectRow = typeof projects.$inferSelect;
export type SceneRow = typeof scenes.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type GenerationRow = typeof generations.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type RecipeRow = typeof recipes.$inferSelect;
export type CostEntryRow = typeof costEntries.$inferSelect;

/** A user-connected generation provider (API key or MCP). Secrets are encrypted at rest. */
export interface ConnectionModel {
  id: string;
  capability: 'image' | 'video' | 'tts' | 'music' | 'llm' | 'stt';
  label: string;
  enabled: boolean;
  /** USD per unit. null = unknown: generation is refused until the user sets it (budget guard needs it). */
  unitCostUsd: number | null;
  unit: 'image' | 'second' | '1k_chars' | '1k_tokens' | 'minute';
  /** Allowed output durations (video). The closest allowed value ≥ the scene is requested. */
  durations?: number[];
  source: 'discovered' | 'catalog' | 'custom';
  /** Extra input fields merged into the provider request (user-owned settings, e.g. Higgsfield endpoint params). */
  extraInput?: Record<string, unknown>;
  notes?: string;
}

export const providerConnections = pgTable('provider_connections', {
  providerId: text('provider_id').primaryKey(),
  status: text('status').$type<'connected' | 'error' | 'authorization_required'>().notNull(),
  secretCiphertext: text('secret_ciphertext'),
  secretHint: text('secret_hint'),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  models: jsonb('models').$type<ConnectionModel[]>().notNull().default([]),
  lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
export type ProviderConnectionRow = typeof providerConnections.$inferSelect;
