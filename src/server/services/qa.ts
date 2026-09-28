/** Deterministic pre-render quality checks. No LLM involvement. */
import type { QaCheck, QaReport, QualityStatus } from '../../shared/schemas';
import type { AssetRow, GenerationRow, ProjectRow, SceneRow } from '../db/schema';
import type { CostSummary } from './costs';
import { timelineIsCurrent } from './timeline';

export interface QaInput {
  project: ProjectRow;
  scenes: SceneRow[];
  assetsById: Map<string, AssetRow>;
  generations: GenerationRow[];
  existingKeys: Set<string>;
  cost: CostSummary;
}

export function runQaChecks(input: QaInput): { report: QaReport; sceneQuality: Map<string, { status: QualityStatus; notes: string }> } {
  const { project, scenes, assetsById, existingKeys, cost } = input;
  const recipe = project.recipeSnapshot;
  const checks: QaCheck[] = [];
  const add = (id: string, label: string, status: QaCheck['status'], message: string, sceneId: string | null = null) => checks.push({ id, label, status, message, sceneId });
  const sceneQuality = new Map<string, { status: QualityStatus; notes: string[] }>();
  const flag = (sceneId: string, status: 'warn' | 'fail', note: string) => {
    const q = sceneQuality.get(sceneId)!;
    if (status === 'fail' || q.status !== 'fail') q.status = status;
    q.notes.push(note);
  };
  const ordered = [...scenes].sort((a, b) => a.index - b.index);
  for (const s of ordered) sceneQuality.set(s.id, { status: 'pass', notes: [] });

  // Narration
  const narration = project.narrationAssetId ? assetsById.get(project.narrationAssetId) : undefined;
  if (!narration || !existingKeys.has(narration.storageKey)) add('narration.present', 'Narration audio', 'fail', 'Narration audio file is missing.');
  else add('narration.present', 'Narration audio', 'pass', `Narration ${project.narrationDurationSec?.toFixed(2)}s (measured).`);

  // Coverage
  const duration = project.narrationDurationSec ?? 0;
  const gaps = ordered.slice(1).filter((s, i) => Math.abs(s.startSec - ordered[i].endSec) > 0.01);
  const covers = ordered.length > 0 && Math.abs(ordered[0].startSec) < 0.01 && Math.abs(ordered[ordered.length - 1].endSec - duration) < 0.01 && gaps.length === 0;
  add('scenes.coverage', 'Scene coverage', covers ? 'pass' : 'fail', covers ? `${ordered.length} scenes tile the full narration.` : 'Scenes do not tile the narration exactly (gaps/overlaps).');

  // Per-scene visuals
  let missingVisuals = 0;
  for (const s of ordered) {
    const a = s.selectedAssetId ? assetsById.get(s.selectedAssetId) : undefined;
    if (!a) { missingVisuals++; flag(s.id, 'fail', 'No visual selected'); add(`scene.${s.index}.visual`, `Scene ${s.index} visual`, 'fail', 'No visual selected.', s.id); continue; }
    if (!existingKeys.has(a.storageKey)) { missingVisuals++; flag(s.id, 'fail', 'Visual file missing on disk'); add(`scene.${s.index}.visual`, `Scene ${s.index} visual`, 'fail', 'Selected visual file is missing.', s.id); continue; }
    const dur = s.endSec - s.startSec;
    if (a.mediaType === 'video' && a.durationSec != null && a.durationSec + 0.05 < dur) {
      flag(s.id, 'warn', `Clip is ${a.durationSec.toFixed(1)}s for a ${dur.toFixed(1)}s scene; it will loop`);
      add(`scene.${s.index}.clipLength`, `Scene ${s.index} clip length`, 'warn', `Clip (${a.durationSec.toFixed(1)}s) shorter than scene (${dur.toFixed(1)}s); will loop.`, s.id);
    }
    if (a.width && a.height) {
      const want = recipe.aspectRatio === '16:9' ? 16 / 9 : recipe.aspectRatio === '9:16' ? 9 / 16 : 1;
      const got = a.width / a.height;
      if (Math.abs(got - want) / want > 0.05) {
        flag(s.id, 'warn', `Aspect ${a.width}x${a.height} differs from ${recipe.aspectRatio}; will be cropped`);
        add(`scene.${s.index}.aspect`, `Scene ${s.index} aspect ratio`, 'warn', `Asset is ${a.width}x${a.height}; project is ${recipe.aspectRatio} (will be cropped).`, s.id);
      }
    }
    if (dur < recipe.minSceneSec * 0.75 || dur > recipe.maxSceneSec * 1.5) {
      flag(s.id, 'warn', `Duration ${dur.toFixed(1)}s outside recipe range`);
      add(`scene.${s.index}.duration`, `Scene ${s.index} duration`, 'warn', `${dur.toFixed(1)}s is outside the recipe's ${recipe.minSceneSec}–${recipe.maxSceneSec}s range.`, s.id);
    }
  }
  if (missingVisuals === 0) add('scenes.visuals', 'Scene visuals', 'pass', 'Every scene has a visual on disk.');

  // Captions
  if (project.captions.enabled) {
    const cues = project.captions.cues;
    if (!cues.length) add('captions.present', 'Captions', 'fail', 'Captions are enabled but have not been generated.');
    else {
      const covered = cues.reduce((acc, c) => acc + (c.end - c.start), 0);
      const words = project.narrationWords ?? [];
      const speech = words.reduce((acc, w) => acc + (w.end - w.start), 0);
      const ok = speech === 0 || covered >= speech * 0.9;
      add('captions.present', 'Captions', ok ? 'pass' : 'warn', ok ? `${cues.length} caption cues.` : 'Captions cover less than 90% of speech.');
    }
  } else add('captions.present', 'Captions', 'pass', 'Captions disabled for this project.');

  // Music
  if (project.music.enabled) {
    const m = project.musicAssetId ? assetsById.get(project.musicAssetId) : undefined;
    if (!m || !existingKeys.has(m.storageKey)) add('music.present', 'Music', 'warn', 'Music is enabled but no music track exists; video will have narration only.');
    else if ((m.durationSec ?? 0) + 0.05 < duration) add('music.present', 'Music', 'warn', 'Music is shorter than the narration; it will loop.');
    else add('music.present', 'Music', 'pass', `Music bed ${m.durationSec?.toFixed(1)}s, volume ${Math.round(project.music.volume * 100)}%.`);
  } else add('music.present', 'Music', 'pass', 'Music disabled for this project.');

  // Timeline freshness
  const current = timelineIsCurrent(project, scenes);
  add('timeline.current', 'Timeline assembled', current ? 'pass' : 'fail', current ? 'Timeline matches current scenes, audio and captions.' : 'Timeline is missing or out of date; re-assemble.');

  // Unresolved generation failures
  const failedScenes = ordered.filter((s) => s.status === 'failed');
  if (failedScenes.length) add('generations.failed', 'Failed generations', 'warn', `Scenes with failed generations: ${failedScenes.map((s) => s.index).join(', ')}.`);

  // Budget
  if (cost.spentUsd > cost.budgetUsd) add('budget', 'Budget', 'fail', `Spent $${cost.spentUsd.toFixed(3)} exceeds budget $${cost.budgetUsd.toFixed(2)}.`);
  else if (cost.spentUsd > cost.budgetUsd * 0.9) add('budget', 'Budget', 'warn', `Spent $${cost.spentUsd.toFixed(3)} of $${cost.budgetUsd.toFixed(2)} (over 90%).`);
  else add('budget', 'Budget', 'pass', `Spent $${cost.spentUsd.toFixed(3)} of $${cost.budgetUsd.toFixed(2)}.`);

  const passed = !checks.some((c) => c.status === 'fail');
  return {
    report: { passed, checks, ranAt: new Date().toISOString() },
    sceneQuality: new Map([...sceneQuality].map(([k, v]) => [k, { status: v.status, notes: v.notes.join('; ') }])),
  };
}
