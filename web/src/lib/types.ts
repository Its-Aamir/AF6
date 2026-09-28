import type {
  AutopilotState, Captions, MusicSettings, ProjectStatus, QaReport, RecipeConfig, RenderReport, Script, SceneBrief, Settings, Timeline, WordTiming,
} from '../../../src/shared/schemas';
export type { AutopilotState, RenderReport };

export type { ProjectStatus, RecipeConfig, Settings, Timeline };

export interface Asset {
  id: string; projectId: string | null; sceneId: string | null; generationId: string | null; kind: string;
  mediaType: 'image' | 'video' | 'audio' | 'archive'; source: 'generated' | 'uploaded' | 'rendered'; label: string;
  storageKey: string; mime: string; bytes: number; durationSec: number | null; width: number | null; height: number | null;
  metadata: Record<string, unknown>; createdAt: string; projectTitle?: string | null;
}

export interface Generation {
  id: string; projectId: string | null; sceneId: string | null; jobId: string | null; capability: string; provider: string; model: string;
  prompt: string; status: string; externalId: string | null; progress: number; submitAttempts: number; error: string | null;
  estimatedCostUsd: number; actualCostUsd: number | null; createdAt: string; updatedAt: string;
}

export interface Job {
  id: string; type: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; attempts: number; maxAttempts: number;
  progress: number; progressMessage: string | null; error: string | null; errorCode: string | null; projectId: string | null; sceneId: string | null;
  runAt: string; createdAt: string; updatedAt: string; startedAt: string | null; finishedAt: string | null; cancelRequested: boolean;
  payload: Record<string, unknown>; result: Record<string, unknown> | null; projectTitle?: string | null;
}

export interface Scene {
  id: string; projectId: string; index: number; startSec: number; endSec: number; durationSec: number; wordStart: number; wordEnd: number; narration: string;
  status: 'pending' | 'planned' | 'queued' | 'generating' | 'generated' | 'failed'; visualStrategy: 'ai_video' | 'ai_image' | null;
  brief: SceneBrief | null; prompt: string | null; negativePrompt: string; provider: string | null; model: string | null; references: string[];
  locked: boolean; selectedAssetId: string | null; qualityStatus: 'unchecked' | 'pass' | 'warn' | 'fail'; qualityNotes: string | null;
  error: string | null; costUsd: number; candidates: Asset[]; activeGenerations: Generation[]; lastGeneration: Generation | null;
}

export interface Project {
  id: string; title: string; inputMode: 'topic' | 'script'; topic: string; sourceScript: string; recipeId: string | null; recipeName: string;
  recipeSnapshot: RecipeConfig; status: ProjectStatus; script: Script | null; voiceId: string; narrationAssetId: string | null;
  narrationDurationSec: number | null; narrationWords: WordTiming[] | null; visualStyleNotes: string | null; music: MusicSettings;
  musicAssetId: string | null; captions: Captions; timeline: Timeline | null; qaReport: QaReport | null; finalRenderAssetId: string | null;
  packageAssetId: string | null; budgetUsd: number; lastError: string | null; createdAt: string; updatedAt: string; busy: boolean; timelineCurrent: boolean;
  voiceoverAssetId: string | null; narrationTimingSource: string | null; autopilot: AutopilotState | null; renderReport: RenderReport | null;
}

export interface ProjectState {
  project: Project; scenes: Scene[]; assets: Asset[]; generations: Generation[]; jobs: Job[]; activeJobs: number;
  costs: { spentUsd: number; pendingUsd: number; budgetUsd: number; remainingUsd: number; byCapability: { capability: string; usd: number }[] };
}

export interface ProjectSummary {
  id: string; title: string; status: ProjectStatus; recipeName: string; aspectRatio: string; narrationDurationSec: number | null; lastError: string | null;
  createdAt: string; updatedAt: string; budgetUsd: number; scenes: number; scenesReady: number; spentUsd: number; activeJobs: number;
  thumbnail: { assetId: string; mediaType: string } | null; hasRender: boolean;
}

export interface Recipe { id: string; slug: string; name: string; description: string; builtIn: boolean; config: RecipeConfig; createdAt: string; updatedAt: string }

export interface ModelInfo { id: string; capability: string; label: string; description: string; unit: string; unitCostUsd: number; maxDurationSec?: number }
export interface Voice { id: string; label: string; description: string; provider: string; providerName: string }
export interface Provider {
  id: string; displayName: string; transport: 'mock' | 'api' | 'mcp'; implemented: boolean; capabilities: string[]; requiredEnv: string[];
  notes: string | null; configured: boolean; missingEnv: string[]; models: ModelInfo[]; voices: Voice[];
}
