import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintPrompt, stripInternalDialogueAttributes } from '../src/modules/prompt-lint.js';

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

test('prompt lint accepts official H3 (Sx) + <d>[Language] ...</d> and ignores negative words inside dialogue', () => {
  const prompt = [
    'subject_definitions: <Subject 1> (S1) 是一条圆润的蓝纹小鱼，外观来自 <Picture 1>。',
    'detailed_description: 温暖的海底玻璃缸背景，柔和顶光，中景固定机位镜头，情绪温柔，<Subject 1> (S1) 游近同伴并张嘴开口说：<d>[Mandarin] 老丑，别难过，别闹了！</d>',
    'overall_soundscape: 轻微气泡与水流声。',
  ].join('\n');
  const issues = lintPrompt(prompt, {
    mode: 'ref2va',
    pictureCount: 1,
    durationSeconds: 7,
    audioLocked: true,
    primaryEntityKind: 'creature',
  });
  assert.ok(!issues.some((issue) => issue.severity === 'error'), `unexpected errors: ${JSON.stringify(issues)}`);
  assert.ok(!issues.some((issue) => issue.key === 'prompt_lint.negative'), 'dialogue "别" must not trigger visual negative lint');
  assert.ok(!issues.some((issue) => issue.key === 'prompt_lint.missing_hair'), 'creature subjects must not require hair/wardrobe');
});

test('stripInternalDialogueAttributes removes speaker/start/end before provider submit', () => {
  const raw = '<Subject 1> speaks: <d speaker="S1" start="0.00" end="6.72">[Mandarin] 你好</d> and <d>[Mandarin] 再见</d>';
  assert.equal(
    stripInternalDialogueAttributes(raw),
    '<Subject 1> speaks: <d>[Mandarin] 你好</d> and <d>[Mandarin] 再见</d>',
  );
});
