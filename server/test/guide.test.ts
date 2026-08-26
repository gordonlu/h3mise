import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveNextAction, deriveProjectAttention, deriveShotGuideState } from '@h3mise/shared';
import type { GuideShotSnapshot } from '@h3mise/shared';

function shot(patch: Partial<GuideShotSnapshot> = {}): GuideShotSnapshot {
  return {
    id: 'shot-001', order: 1, title: '城门追逐', hasDirectorPlan: false,
    missingReferences: [], hasPrompt: false, preflightBlocked: null,
    activeRenderJobId: null, takeCount: 0, selectedTakeId: null, ...patch,
  };
}

test('shot guide is derived from artifacts instead of ShotStatus', () => {
  const state = deriveShotGuideState(shot({ hasDirectorPlan: true, hasPrompt: true, preflightBlocked: false }));
  assert.equal(state.designReady, true);
  assert.equal(state.renderReady, true);
  assert.equal(state.steps.find((step) => step.key === 'generate')?.state, 'current');
});

test('fresh shot starts with design even when its mode requires references', () => {
  const state = deriveShotGuideState(shot({ missingReferences: ['First Frame'] }));
  assert.equal(state.steps.find((step) => step.key === 'design')?.state, 'current');
  assert.equal(state.steps.find((step) => step.key === 'references')?.state, 'upcoming');
});

test('next action prioritizes completed render waiting for selection', () => {
  const action = deriveNextAction(shot({ takeCount: 3, missingReferences: ['First Frame'] }));
  assert.equal(action.kind, 'select_take');
});

test('project attention prioritizes selection, then blockers', () => {
  const summary = deriveProjectAttention([
    shot({ id: 'shot-001', missingReferences: ['First Frame'] }),
    shot({ id: 'shot-002', order: 2, takeCount: 2 }),
  ]);
  assert.equal(summary.attention.kind, 'select_take');
  assert.equal(summary.awaitingSelectionCount, 1);
  assert.equal(summary.missingReferencesCount, 1);
});

test('completed project proceeds to timeline before export', () => {
  const summary = deriveProjectAttention([shot({ selectedTakeId: 'take-001', takeCount: 1 })], 0);
  assert.equal(summary.attention.kind, 'open_timeline');
});

test('a persisted timeline export completes the project guide', () => {
  const ready = [shot({ selectedTakeId: 'take-001', takeCount: 1 })];
  assert.equal(deriveProjectAttention(ready, 1, 0).attention.kind, 'export');
  const completed = deriveProjectAttention(ready, 1, 1);
  assert.equal(completed.attention.kind, 'complete');
  assert.equal(completed.exportCount, 1);
});
