// Deterministic prompt lint. No AI, no provider call: it catches wording that
// paid models commonly misread before the user spends a render.
import type { H3Mode } from '@h3mise/shared';

export interface PromptLintIssue {
  key: string;
  severity: 'error' | 'warning' | 'info';
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

export function lintPrompt(text: string, options: { mode?: H3Mode; hasAudioRefs?: boolean; hasDialogue?: boolean; pictureCount?: number; audioCount?: number; durationSeconds?: number; nativeDialogue?: boolean } = {}): PromptLintIssue[] {
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

  const pictureCount = options.pictureCount ?? 0;
  const audioCount = options.audioCount ?? (options.hasAudioRefs ? 1 : 0);
  const citedPictures = [...clean.matchAll(/<Picture\s+(\d+)>/gi)].map((match) => Number(match[1]));
  const citedAudios = [...clean.matchAll(/<Audio\s+(\d+)>/gi)].map((match) => Number(match[1]));
  if (options.mode === 't2va' && (citedPictures.length || citedAudios.length || /retention_analysis\s*:|subject_definitions\s*:/i.test(clean))) {
    issues.push({ key: 'prompt_lint.mode_mixed', severity: 'error', message: 'T2VA 最终 Prompt 混入了 Ref2VA/音频参考内容', suggestion: '改用 Ref2VA，或移除参考图编号和参考模式段落' });
  }
  for (const [kind, cited, count] of [['Picture', citedPictures, pictureCount], ['Audio', citedAudios, audioCount]] as const) {
    const invalid = cited.filter((index) => index < 1 || index > count);
    if (invalid.length) {
      issues.push({ key: `prompt_lint.${kind.toLowerCase()}_range`, severity: 'error', message: `<${kind} N> 引用了不存在的编号：${[...new Set(invalid)].join('、')}；实际共 ${count} 项`, suggestion: `只使用 <${kind} 1> 到 <${kind} ${count}>，并与付费前缩略图顺序核对` });
    }
    if (count > 0) {
      const missing = Array.from({ length: count }, (_, index) => index + 1).filter((index) => !cited.includes(index));
      if (missing.length) {
        issues.push({ key: `prompt_lint.${kind.toLowerCase()}_missing`, severity: 'error', message: `最终 Prompt 未引用 ${missing.map((index) => `<${kind} ${index}>`).join('、')}`, suggestion: '重新编译最终 Prompt，确保每个实际上传的参考素材都有准确编号' });
      }
    }
  }

  const dialogueTags = [...clean.matchAll(/<d\b([^>]*)>([\s\S]*?)<\/d>/gi)];
  for (const match of dialogueTags) {
    const attributes = match[1] ?? '';
    if (!/\bspeaker\s*=\s*["'][^"']+["']/i.test(attributes)) {
      issues.push({ key: 'prompt_lint.dialogue_speaker', severity: 'error', message: '对白缺少明确的 speaker 角色标记', suggestion: '每句对白都标记说话角色，避免模型把台词分配给错误人物' });
    }
    const start = Number(attributes.match(/\bstart\s*=\s*["']([\d.]+)["']/i)?.[1]);
    const end = Number(attributes.match(/\bend\s*=\s*["']([\d.]+)["']/i)?.[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || (options.durationSeconds !== undefined && end > options.durationSeconds + 0.001)) {
      issues.push({ key: 'prompt_lint.dialogue_time', severity: 'error', message: `对白时间无效或超出 Shot：${attributes.trim()}`, suggestion: '确保 0 ≤ start < end ≤ Shot 时长' });
    }
  }
  if (options.nativeDialogue && dialogueTags.length) {
    issues.push({ key: 'prompt_lint.native_timing', severity: 'warning', message: 'H3 原生对白不能保证精确秒级起止', suggestion: '精确对口型请改用带 <Audio 1>、fully_copy 和明确起止时间的音频参考，并在本地对 Selected Take 校时' });
  }

  const soundscape = clean.match(/overall_soundscape\s*:([\s\S]*?)(?:\n\s*\n|\n[a-z_]+\s*:|$)/i)?.[1] ?? '';
  const duplicatedDialogue = dialogueTags.map((match) => (match[2] ?? '').trim()).filter((dialogue) => dialogue.length > 1 && soundscape.includes(dialogue));
  if (duplicatedDialogue.length) {
    issues.push({ key: 'prompt_lint.soundscape_dialogue', severity: 'error', message: 'overall_soundscape 重复包含对白文本', suggestion: '声景只写环境声与非对白声音；对白只保留在带角色和时间的对白段或音频参考中' });
  }
  const rewriteSections = (clean.match(/^(?:rewrite|subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music)\s*:/gim) ?? []).length;
  if (/\brewrite\b/i.test(clean) && /silent|silence|静默|无声/i.test(clean) && rewriteSections >= 3) {
    issues.push({ key: 'prompt_lint.rewrite_payload', severity: 'error', message: '检测到 rewrite 的静默六段稿，不能作为最终渲染 payload', suggestion: '回到最终 Prompt 编译步骤，明确音频策略后再生成 final 版本' });
  }
  if (/监控摄像机入画|surveillance camera (?:in frame|visible)|camera (?:in frame|visible)/i.test(clean)) {
    issues.push({ key: 'prompt_lint.camera_visible', severity: 'warning', message: 'Prompt 可能要求监控摄像机实体入画', suggestion: '模拟监控视角应使用画面外固定机位；CCTV 文字通过后期 overlay 添加' });
  }

  return issues;
}
