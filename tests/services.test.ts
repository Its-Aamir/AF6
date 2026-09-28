import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../src/server/db/client';
import { costEntries } from '../src/server/db/schema';
import { assertWithinBudget, projectCostSummary } from '../src/server/services/costs';
import { createProject } from '../src/server/services/projects';
import { runQaChecks } from '../src/server/services/qa';
import { assembleTimeline } from '../src/server/services/timeline';
import { resetDb } from './helpers';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function newProject(budgetUsd = 1) {
  const db = getDb();
  const recipe = (await db.query.recipes.findMany())[0];
  return createProject(db, { title: 'T', inputMode: 'topic', topic: 'volcanoes', sourceScript: '', recipeId: recipe.id, budgetUsd });
}

describe('budget guard', () => {
  it('blocks spend beyond the budget, counting in-flight estimates', async () => {
    const db = getDb();
    const p = await newProject(1);
    await assertWithinBudget(db, p.id, 0.9);
    await db.insert(costEntries).values({ projectId: p.id, kind: 'actual', capability: 'image', provider: 'mock', model: 'm', units: 1, unit: 'image', unitCostUsd: 0.8, amountUsd: 0.8, simulated: true });
    const s = await projectCostSummary(db, p.id, 1);
    expect(s.spentUsd).toBe(0.8);
    expect(s.remainingUsd).toBeCloseTo(0.2, 5);
    await expect(assertWithinBudget(db, p.id, 0.5)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });
});

describe('timeline + QA', () => {
  it('refuses to assemble with missing visuals and flags them in QA', async () => {
    const p = await newProject();
    const project = { ...p, narrationAssetId: '00000000-0000-0000-0000-000000000001', narrationDurationSec: 10 };
    const scene = (i: number, start: number, end: number, asset: string | null) => ({
      id: `s${i}`, projectId: p.id, index: i, startSec: start, endSec: end, wordStart: 0, wordEnd: 1, narration: 'x', status: asset ? 'generated' : 'planned',
      visualStrategy: 'ai_image', brief: null, prompt: 'p', negativePrompt: '', provider: 'mock', model: 'm', references: [], locked: false,
      selectedAssetId: asset, qualityStatus: 'unchecked', qualityNotes: null, error: null, createdAt: new Date(), updatedAt: new Date(),
    });
    const asset = { id: 'a1', projectId: p.id, sceneId: 's1', generationId: null, kind: 'image', mediaType: 'image' as const, source: 'generated' as const, label: '', storageKey: 'k1.png', mime: 'image/png', bytes: 1, durationSec: null, width: 1280, height: 720, metadata: {}, createdAt: new Date() };
    const scenes = [scene(1, 0, 5, 'a1'), scene(2, 5, 10, null)];
    expect(() => assembleTimeline(project, scenes, new Map([['a1', asset]]))).toThrow(/Scenes without a usable visual: 2/);
    const tl = assembleTimeline(project, [scene(1, 0, 5, 'a1'), scene(2, 5, 10, 'a1')], new Map([['a1', asset]]));
    expect(tl.video).toHaveLength(2);
    expect(tl.durationSec).toBe(10);
    const qa = runQaChecks({ project: { ...project, timeline: null }, scenes, assetsById: new Map([['a1', asset]]), generations: [], existingKeys: new Set(['k1.png']), cost: { spentUsd: 0, pendingUsd: 0, budgetUsd: 1, remainingUsd: 1 } });
    expect(qa.report.passed).toBe(false);
    expect(qa.report.checks.find((c) => c.id === 'scene.2.visual')?.status).toBe('fail');
    expect(qa.report.checks.find((c) => c.id === 'narration.present')?.status).toBe('fail'); // file missing on disk
    expect(qa.sceneQuality.get('s2')?.status).toBe('fail');
    expect(qa.sceneQuality.get('s1')?.status).toBe('pass');
  });
});
