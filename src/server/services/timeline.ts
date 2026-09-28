/** Deterministic timeline assembly. The narration is the master clock. */
import { resolutionFor, type Timeline } from '../../shared/schemas';
import type { AssetRow, ProjectRow, SceneRow } from '../db/schema';
import { AppError } from '../errors';

export const TIMELINE_FPS = 24;

export function assembleTimeline(project: ProjectRow, scenes: SceneRow[], assetsById: Map<string, AssetRow>): Timeline {
  if (!project.narrationAssetId || !project.narrationDurationSec) throw new AppError('INVALID_STATE', 'Narration is missing; generate narration first.');
  if (!scenes.length) throw new AppError('INVALID_STATE', 'No scenes to assemble.');
  const ordered = [...scenes].sort((a, b) => a.index - b.index);
  const missing = ordered.filter((s) => {
    const a = s.selectedAssetId ? assetsById.get(s.selectedAssetId) : undefined;
    return !a || (a.mediaType !== 'image' && a.mediaType !== 'video');
  });
  if (missing.length) {
    throw new AppError('INVALID_STATE', `Scenes without a usable visual: ${missing.map((s) => s.index).join(', ')}`, { details: { sceneIds: missing.map((s) => s.id) } });
  }
  const duration = project.narrationDurationSec;
  const eps = 0.01;
  if (Math.abs(ordered[0].startSec) > eps) throw new AppError('INVALID_STATE', 'First scene must start at 0s.');
  for (let i = 1; i < ordered.length; i++) {
    if (Math.abs(ordered[i].startSec - ordered[i - 1].endSec) > eps) throw new AppError('INVALID_STATE', `Gap/overlap between scenes ${ordered[i - 1].index} and ${ordered[i].index}.`);
  }
  if (Math.abs(ordered[ordered.length - 1].endSec - duration) > eps) throw new AppError('INVALID_STATE', 'Scenes do not cover the full narration.');

  const { width, height } = resolutionFor(project.recipeSnapshot.aspectRatio, 'final');
  const cues = project.captions.cues;
  return {
    version: 1,
    durationSec: duration,
    width,
    height,
    fps: TIMELINE_FPS,
    video: ordered.map((s) => {
      const a = assetsById.get(s.selectedAssetId!)!;
      return {
        sceneId: s.id, index: s.index, start: s.startSec, end: s.endSec, assetId: a.id,
        mediaKind: a.mediaType as 'image' | 'video',
        motion: a.mediaType === 'image' ? (s.brief?.camera ?? 'slow_push_in') : 'static',
      };
    }),
    narration: { assetId: project.narrationAssetId, start: 0, end: duration },
    music: project.music.enabled && project.musicAssetId ? { assetId: project.musicAssetId, volume: project.music.volume, duck: project.music.duck } : null,
    captions: project.captions.enabled && cues.length ? { position: project.captions.position, cues } : null,
    assembledAt: new Date().toISOString(),
  };
}

/** Whether the stored timeline still reflects the current scenes/audio/captions. */
export function timelineIsCurrent(project: ProjectRow, scenes: SceneRow[]): boolean {
  const t = project.timeline;
  if (!t) return false;
  const ordered = [...scenes].sort((a, b) => a.index - b.index);
  if (t.video.length !== ordered.length) return false;
  const videoOk = ordered.every((s, i) => {
    const c = t.video[i];
    return c.sceneId === s.id && c.assetId === s.selectedAssetId && Math.abs(c.start - s.startSec) < 0.01 && Math.abs(c.end - s.endSec) < 0.01;
  });
  const musicWanted = project.music.enabled && project.musicAssetId ? project.musicAssetId : null;
  const captionsWanted = project.captions.enabled && project.captions.cues.length > 0;
  return videoOk
    && t.narration.assetId === project.narrationAssetId
    && (t.music?.assetId ?? null) === musicWanted
    && (t.music ? t.music.volume === project.music.volume && t.music.duck === project.music.duck : true)
    && (!!t.captions === captionsWanted)
    && (!t.captions || (t.captions.cues.length === project.captions.cues.length && t.captions.position === project.captions.position));
}
