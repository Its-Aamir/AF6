/**
 * "Ready to upload" report, computed after every render from the actual file
 * plus provenance of every asset. Anything simulated blocks publishing.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { RenderReport, RenderReportCheck } from '../../shared/schemas';
import type { Tx } from '../db/client';
import { assets, costEntries, generations, scenes, type ProjectRow } from '../db/schema';
import type { MediaAnalysis } from '../media/analyze';

export async function simulatedContent(db: Tx, p: ProjectRow): Promise<string[]> {
  const out: string[] = [];
  const sceneRows = await db.select().from(scenes).where(eq(scenes.projectId, p.id));
  const ids = [p.narrationAssetId, p.musicAssetId, ...sceneRows.map((s) => s.selectedAssetId)].filter((x): x is string => !!x);
  const rows = ids.length ? await db.select().from(assets).where(inArray(assets.id, ids)) : [];
  const genIds = rows.map((a) => a.generationId).filter((x): x is string => !!x);
  const gens = genIds.length ? await db.select().from(generations).where(inArray(generations.id, genIds)) : [];
  const isMock = (assetId: string | null) => {
    const a = rows.find((r) => r.id === assetId);
    if (!a || a.source === 'uploaded') return false;
    return gens.find((g) => g.id === a.generationId)?.provider === 'mock';
  };
  if (isMock(p.narrationAssetId)) out.push('Narration uses the simulated voice — connect ElevenLabs (or upload your voiceover) and regenerate narration.');
  const mockScenes = sceneRows.filter((s) => isMock(s.selectedAssetId)).map((s) => s.index).sort((a, b) => a - b);
  if (mockScenes.length) out.push(`Scenes ${mockScenes.join(', ')} use simulated visuals — connect Veo, Kling or Higgsfield (or upload visuals) and regenerate them.`);
  if (p.music.enabled && isMock(p.musicAssetId)) out.push('Music is the simulated placeholder — upload your music track or disable music.');
  if (p.inputMode === 'topic') {
    const llm = await db.select({ provider: costEntries.provider }).from(costEntries).where(and(eq(costEntries.projectId, p.id), eq(costEntries.capability, 'llm')));
    if (llm.length && llm.every((c) => c.provider === 'mock')) out.push('The script was written by the simulated AI Director — connect Claude and regenerate the script, or paste your own script.');
  }
  return out;
}

export function buildRenderReport(input: {
  assetId: string; durationSec: number; width: number; height: number; preset: string; analysis: MediaAnalysis; simulated: string[];
}): RenderReport {
  const { analysis: a } = input;
  const checks: RenderReportCheck[] = [];
  const add = (id: string, label: string, status: RenderReportCheck['status'], message: string) => checks.push({ id, label, status, message });
  add('content', 'Real content only', input.simulated.length ? 'fail' : 'pass', input.simulated.length ? input.simulated.join(' ') : 'Voice, visuals and music are real or uploaded.');
  add('resolution', 'Resolution', input.preset === 'draft' ? 'fail' : 'pass', input.preset === 'draft' ? `Draft render (${input.width}×${input.height}) — render with Final or HD for upload.` : `${input.width}×${input.height}`);
  if (a.integratedLufs == null) add('loudness', 'Loudness', 'warn', 'Loudness could not be measured.');
  else {
    const ok = a.integratedLufs >= -16 && a.integratedLufs <= -12;
    add('loudness', 'Loudness', ok ? 'pass' : 'warn', `${a.integratedLufs.toFixed(1)} LUFS integrated (YouTube reference −14)${a.truePeakDb != null ? `, true peak ${a.truePeakDb.toFixed(1)} dBTP` : ''}.`);
  }
  if (a.truePeakDb != null && a.truePeakDb > -0.5) add('peak', 'Clipping', 'warn', `True peak ${a.truePeakDb.toFixed(1)} dBTP — may distort after encoding.`);
  const longBlack = a.blackSegments.filter((s) => s.end - s.start >= 1);
  add('black', 'Black frames', longBlack.some((s) => s.end - s.start >= 3) ? 'fail' : longBlack.length ? 'warn' : 'pass',
    longBlack.length ? `Black video at ${longBlack.map((s) => `${s.start.toFixed(1)}–${s.end.toFixed(1)}s`).join(', ')}.` : 'No black frames.');
  const gaps = a.silentSegments.filter((s) => s.end - s.start >= 2);
  add('silence', 'Silence', gaps.length ? 'warn' : 'pass', gaps.length ? `Silent audio at ${gaps.map((s) => `${s.start.toFixed(1)}–${s.end.toFixed(1)}s`).join(', ')}.` : 'No long silences.');
  return {
    assetId: input.assetId, measuredAt: new Date().toISOString(), durationSec: input.durationSec, width: input.width, height: input.height,
    integratedLufs: a.integratedLufs, truePeakDb: a.truePeakDb, blackSegments: a.blackSegments, silentSegments: a.silentSegments,
    simulatedContent: input.simulated, publishReady: !checks.some((c) => c.status === 'fail'), checks,
  };
}
