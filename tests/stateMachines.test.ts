import { describe, expect, it } from 'vitest';
import { InvalidTransitionError, isStepComplete, nextProjectStatus, nextSceneStatus, whyCannotStart } from '../src/shared/stateMachines';

describe('project state machine', () => {
  it('walks the happy path in order', () => {
    let s = nextProjectStatus('draft', { type: 'START', step: 'script' });
    expect(s).toBe('scripting');
    s = nextProjectStatus(s, { type: 'DONE', step: 'script' });
    expect(s).toBe('scripted');
    s = nextProjectStatus(nextProjectStatus(s, { type: 'START', step: 'narration' }), { type: 'DONE', step: 'narration' });
    expect(s).toBe('narrated');
    s = nextProjectStatus(nextProjectStatus(s, { type: 'START', step: 'segment' }), { type: 'DONE', step: 'segment' });
    s = nextProjectStatus(nextProjectStatus(s, { type: 'START', step: 'plan' }), { type: 'DONE', step: 'plan' });
    expect(s).toBe('planned');
    s = nextProjectStatus(s, { type: 'START', step: 'assets' });
    expect(s).toBe('producing');
    s = nextProjectStatus(s, { type: 'ASSETS_SETTLED', allAssetsReady: true });
    expect(s).toBe('assets_ready');
    s = nextProjectStatus(s, { type: 'START', step: 'assemble' });
    expect(s).toBe('assembled');
    s = nextProjectStatus(nextProjectStatus(s, { type: 'START', step: 'qa' }), { type: 'DONE', step: 'qa', passed: true });
    expect(s).toBe('qa_passed');
    s = nextProjectStatus(nextProjectStatus(s, { type: 'START', step: 'render' }), { type: 'DONE', step: 'render' });
    expect(s).toBe('rendered');
  });

  it('refuses to skip steps', () => {
    expect(() => nextProjectStatus('draft', { type: 'START', step: 'narration' })).toThrow(InvalidTransitionError);
    expect(() => nextProjectStatus('scripted', { type: 'START', step: 'render' })).toThrow(/must reach/);
    expect(whyCannotStart('assembled', 'render')).toMatch(/must reach/);
  });

  it('refuses to start while busy, and to render after failed QA', () => {
    expect(whyCannotStart('narrating', 'script')).toMatch(/another pipeline step/);
    expect(whyCannotStart('producing', 'qa')).toMatch(/still generating/);
    expect(whyCannotStart('producing', 'assets')).toBeNull();
    expect(() => nextProjectStatus('qa_failed', { type: 'START', step: 'render' })).toThrow();
  });

  it('allows explicit rewinds from later stages', () => {
    expect(nextProjectStatus('rendered', { type: 'START', step: 'script' })).toBe('scripting');
    expect(nextProjectStatus('rendered', { type: 'START', step: 'assets' })).toBe('producing');
  });

  it('reverts to the recorded stable status on failure', () => {
    expect(nextProjectStatus('narrating', { type: 'FAILED', step: 'narration', revertTo: 'scripted' })).toBe('scripted');
    expect(nextProjectStatus('rendering', { type: 'FAILED', step: 'render', revertTo: 'rendered' })).toBe('rendered');
    // failure for a step that is no longer running must not clobber
    expect(nextProjectStatus('segmented', { type: 'FAILED', step: 'narration', revertTo: 'scripted' })).toBe('segmented');
  });

  it('marks downstream work stale when the timeline changes', () => {
    expect(nextProjectStatus('rendered', { type: 'TIMELINE_STALE', allAssetsReady: true })).toBe('assets_ready');
    expect(nextProjectStatus('qa_passed', { type: 'TIMELINE_STALE', allAssetsReady: false })).toBe('planned');
    expect(nextProjectStatus('planned', { type: 'TIMELINE_STALE', allAssetsReady: true })).toBe('planned');
    expect(nextProjectStatus('rendering', { type: 'TIMELINE_STALE', allAssetsReady: true })).toBe('rendering');
  });

  it('reports step completion for the stage rail', () => {
    expect(isStepComplete('assets_ready', 'assets')).toBe(true);
    expect(isStepComplete('producing', 'assets')).toBe(false);
    expect(isStepComplete('qa_failed', 'qa')).toBe(false);
    expect(isStepComplete('rendering', 'qa')).toBe(true);
  });
});

describe('scene state machine', () => {
  const s = (status: any, locked = false, hasAsset = false) => ({ status, locked, hasAsset });
  it('requires a brief before generation', () => {
    expect(() => nextSceneStatus(s('pending'), { type: 'ENQUEUE' })).toThrow(/plan visuals/);
    expect(nextSceneStatus(s('planned'), { type: 'ENQUEUE' })).toBe('queued');
  });
  it('locked scenes reject changes', () => {
    for (const type of ['ENQUEUE', 'EDIT', 'REPLACE', 'PLAN'] as const) expect(() => nextSceneStatus(s('generated', true, true), { type })).toThrow(/locked/);
  });
  it('failure keeps an existing visual', () => {
    expect(nextSceneStatus(s('generating', false, true), { type: 'FAIL' })).toBe('generated');
    expect(nextSceneStatus(s('generating', false, false), { type: 'FAIL' })).toBe('failed');
  });
  it('cannot edit while generating', () => {
    expect(() => nextSceneStatus(s('generating'), { type: 'EDIT' })).toThrow(/in progress/);
  });
});
