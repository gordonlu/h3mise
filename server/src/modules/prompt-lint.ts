// Deterministic prompt lint. No AI, no provider call: it catches wording that
// paid models commonly misread before the user spends a render.
import type { H3Mode } from '@h3mise/shared';

export interface PromptLintIssue {
  key: string;
  severity: 'warning' | 'info';
  message: string;
  suggestion: string;
}

const NEGATIVE_PATTERNS: Array<{ re: RegExp; label: string; suggestion: string }> = [
  { re: /不要|别(?:再)?|禁止|不能|避免/g, label: '中文否定词', suggestion: '改写成正向可见状态，例如“保持严肃”“移除窗户”“双手自然下垂”' },
  { re: /\bno\s+\w+|\bnot\s+\w+|\bwithout\s+\w+|\bnever\s+\w+|don't|doesn't/g, label: 'English negation', suggestion: 'Describe the positive state instead (for example "lips closed", "plain wall", "hands still")' },
];

const FIELD_CHECKS: Array<{ key: string; label: string; re: RegExp; suggestion: string }> = [
  { key: 'subject', label: '主体', re: /subject|主体|人物|角色|character|creature|performer|歌手|演员/i, suggestion: '明确谁在画面里，以及身份/外观由哪张参考图决定' },
  { key: 'background', label: '背景', re: /background|背景|environment|场景|location|room|室内|室外|舞台/i, suggestion: '写清背景空间与前后景关系，不要只写人物' },
  { key: 'lighting', label: '光线', re: /light|光|照明|shadow|影|key light|backlight|轮廓光/i, suggestion: '补充主光方向、色温、明暗对比' },
  { key: 'camera', label: '镜头', re: /camera|镜头|机位|framing|shot size|close.?up|wide|medium|焦段|lens/i, suggestion: '写清景别、机位和镜头运动' },
  { key: 'performance', label: '情绪/表演', re: /emotion|情绪|表情|performance|表演|gaze|凝视|objective|动作|mouth|口型|lip/i, suggestion: '写清情绪、眼神、口型和动作节奏' },
  { key: 'hair', label: '头发/造型', re: /hair|头发|发型|wardrobe|服装|costume|outfit|造型/i, suggestion: '若造型重要，明确发型、服装和配饰' },
];

const HALF_SENTENCE = /[，,、；;：:]\s*$|\b(?:and|but|with|then)\s*$/i;

export function lintPrompt(text: string, options: { mode?: H3Mode; hasAudioRefs?: boolean; hasDialogue?: boolean } = {}): PromptLintIssue[] {
  const issues: PromptLintIssue[] = [];
  const clean = text.trim();
  if (!clean) {
    issues.push({ key: 'prompt_lint.empty', severity: 'warning', message: '提示词为空', suggestion: '先编译或填写 Prompt' });
    return issues;
  }

  const negatives = [...new Set(NEGATIVE_PATTERNS.flatMap(({ re, label, suggestion }) => {
    const matches = clean.match(re) ?? [];
    return matches.length ? [{ label, words: [...new Set(matches)].join('、'), suggestion }] : [];
  }))];
  for (const item of negatives) {
    issues.push({
      key: 'prompt_lint.negative',
      severity: 'warning',
      message: `检测到${item.label}：${item.words}`,
      suggestion: item.suggestion,
    });
  }

  for (const field of FIELD_CHECKS) {
    if (!field.re.test(clean)) {
      issues.push({
        key: `prompt_lint.missing_${field.key}`,
        severity: 'warning',
        message: `Prompt 没有明确写${field.label}`,
        suggestion: field.suggestion,
      });
    }
  }

  if (HALF_SENTENCE.test(clean)) {
    issues.push({
      key: 'prompt_lint.half_sentence',
      severity: 'warning',
      message: 'Prompt 可能在半句/连接词处结束',
      suggestion: '补全完整的动作、情绪或环境描述后再提交',
    });
  }

  if (options.hasAudioRefs && !/audio|音频|参考音频|音轨|vocal|原唱|口型|lip/i.test(clean)) {
    issues.push({
      key: 'prompt_lint.audio_missing',
      severity: 'warning',
      message: '已绑定参考音频，但 Prompt 没有说明音频用途',
      suggestion: '写明音频是语气/节奏参考，还是要求口型/原唱；不要假设模型会 1:1 复制音轨',
    });
  }
  if (options.hasDialogue && !/spoken|dialogue|对白|台词|口型|lip|说|唱/i.test(clean)) {
    issues.push({
      key: 'prompt_lint.dialogue_missing',
      severity: 'warning',
      message: 'Prompt 似乎包含对白/歌词，但没有写口型或说唱动作',
      suggestion: '明确谁在说/唱、口型节奏和镜头停顿',
    });
  }

  return issues;
}
