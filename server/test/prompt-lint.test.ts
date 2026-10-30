import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintPrompt } from '../src/modules/prompt-lint.js';

test('prompt lint flags negative wording, missing fields, half sentences and audio ambiguity', () => {
  const issues = lintPrompt('不要微笑，画面里没有窗户，主角站着，', { hasAudioRefs: true });
  const keys = issues.map((issue) => issue.key);
  assert.ok(keys.includes('prompt_lint.negative'));
  assert.ok(keys.includes('prompt_lint.half_sentence'));
  assert.ok(keys.includes('prompt_lint.audio_missing'));
  assert.ok(keys.includes('prompt_lint.missing_lighting'));

  const clean = lintPrompt('Mia stands still in a dim rehearsal room. Soft side light, medium close-up, calm expression, tied-back hair, black coat, fixed camera. Audio is a rhythm reference only.');
  assert.ok(!clean.some((issue) => issue.key === 'prompt_lint.negative'));
  assert.ok(!clean.some((issue) => issue.key === 'prompt_lint.half_sentence'));
});
