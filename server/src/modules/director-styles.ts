import type { DirectorStylePreset, ResolvedDirectorStyle } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';

export const DIRECTOR_STYLE_PRESETS: DirectorStylePreset[] = [
  {
    id: 'hk-studio-wuxia-1970s', name: '70 年代香港棚拍武侠', aliases: ['邵氏', '邵氏电影', '老派香港武侠'], tags: ['武侠', '古装', '棚拍', '复古'],
    medium: ['live-action', 'vintage 1970s Hong Kong studio wuxia'],
    productionDesign: ['theatrical painted sets', 'saturated costume colors', 'visible stage smoke'],
    lighting: ['hard directional key light', 'strong rim separation'],
    performance: ['stylized martial-arts poses', 'clear anticipation and held finishing poses'],
    camera: ['symmetrical medium-wide compositions', 'brief fast push-in only at dramatic reveals'],
    editing: ['clean impact-motivated cuts', 'hold long enough to read each move'],
    sound: ['crisp percussion accents synchronized with impacts', 'restrained traditional instrumentation'],
    avoid: ['do not copy recognizable characters, sects, weapons, sets, or scenes from existing films'],
  },
  {
    id: 'ensemble-wuxia-sitcom', name: '棚拍群像武侠情景喜剧', aliases: ['武林外传', '武侠情景喜剧', '客栈群像喜剧'], tags: ['喜剧', '武侠', '群像', '对白', '棚拍'],
    medium: ['live-action ensemble martial-arts sitcom'],
    productionDesign: ['recurring theatrical interior set', 'readable entrances and group blocking zones'],
    lighting: ['warm tungsten practical lighting', 'soft even facial exposure'],
    performance: ['rapid dialogue handoffs', 'restrained physical comedy', 'brief reaction pause after punchlines'],
    camera: ['medium-wide group staging during dialogue', 'mostly static camera', 'reaction close-up only when narratively motivated'],
    editing: ['preserve dialogue continuity', 'avoid excessive cuts during ensemble exchanges'],
    sound: ['clear dialogue over light room ambience', 'short restrained comic punctuation'],
    avoid: ['do not copy a recognizable inn layout, characters, relationships, catchphrases, costumes, or classic scenes'],
  },
  {
    id: 'hk-heroic-crime-1990s', name: '80–90 年代港式英雄警匪', aliases: ['港片', '香港警匪片', '英雄本色感', '老港片'], tags: ['警匪', '动作', '兄弟情', '都市', '港片'],
    medium: ['live-action 1980s–1990s Hong Kong heroic crime cinema'],
    productionDesign: ['dense urban streets', 'practical vehicles and lived-in interiors'],
    lighting: ['hard cyan and amber backlighting', 'deep night shadows', 'wet reflective pavement'],
    performance: ['controlled tension before sudden action', 'emotion expressed through gaze and restrained gestures'],
    camera: ['long-lens close-ups', 'energetic handheld tracking only during pursuit or combat'],
    editing: ['fast cuts only at action impacts', 'longer holds for confrontation and loyalty beats'],
    sound: ['sharp practical impacts', 'urban ambience', 'restrained dramatic score'],
    avoid: ['do not reproduce iconic characters, costumes, gun poses, dialogue, or shot-for-shot sequences'],
  },
  {
    id: 'hk-neon-noir', name: '香港霓虹犯罪黑色电影', aliases: ['霓虹港片', '香港黑色电影', '重庆森林感'], tags: ['霓虹', '犯罪', '都市', '夜景', '黑色电影'],
    medium: ['live-action Hong Kong urban noir'],
    productionDesign: ['crowded narrow streets', 'layered glass reflections', 'weathered practical locations'],
    lighting: ['mixed neon color temperatures', 'deep shadow pockets', 'rain-softened highlights'],
    performance: ['internal tension', 'minimal gestures', 'meaningful eyelines'],
    camera: ['close observational framing', 'slow tracking or locked compositions chosen per shot'],
    editing: ['elliptical but spatially readable transitions', 'do not cut without new information'],
    sound: ['dense street ambience', 'distant traffic and ventilation hum', 'sparse low-tempo score'],
    avoid: ['do not copy recognizable plots, monologues, locations, or signature compositions from existing films'],
  },
  {
    id: 'modern-vertical-drama', name: '现代竖屏高密度短剧', aliases: ['短剧风格', '竖屏短剧', '网剧'], tags: ['短剧', '竖屏', '反转', '高密度'],
    medium: ['live-action modern vertical short drama'],
    productionDesign: ['simple readable locations', 'high subject-background separation'],
    lighting: ['clean facial lighting', 'controlled practical highlights'],
    performance: ['immediate readable emotion', 'clear reaction turns without exaggerated flailing'],
    camera: ['close and medium-close framing optimized for vertical composition', 'one dominant camera behavior per shot'],
    editing: ['open with conflict or unanswered information', 'reserve time for reaction and payoff'],
    sound: ['clear foreground dialogue', 'concise transition accents', 'consistent loudness'],
    avoid: ['avoid empty luxury imagery, excessive reaction cuts, unsupported identity reveals, and unearned reversals'],
  },
];

export function resolveDirectorStyle(query: string | null | undefined): ResolvedDirectorStyle {
  const clean = String(query ?? '').trim();
  if (!clean) return { userQuery: '', preset: null, match: 'none' };
  const lower = clean.toLowerCase();
  const aliasMatches = DIRECTOR_STYLE_PRESETS.flatMap((preset) =>
    [preset.name, ...preset.aliases]
      .filter((item) => lower.includes(item.toLowerCase()))
      .map((item) => ({ preset, length: item.length })),
  ).sort((a, b) => b.length - a.length);
  if (aliasMatches[0]) return { userQuery: clean, preset: aliasMatches[0].preset, match: 'alias' };
  const tagMatches = DIRECTOR_STYLE_PRESETS.map((preset) => ({
    preset,
    score: preset.tags.reduce((score, item) => score + (lower.includes(item.toLowerCase()) ? item.length : 0), 0),
  })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  return { userQuery: clean, preset: tagMatches[0]?.preset ?? null, match: tagMatches[0] ? 'tag' : 'custom' };
}

function directives(preset: DirectorStylePreset): Record<string, string[]> {
  return {
    medium: preset.medium, production_design: preset.productionDesign, lighting: preset.lighting,
    performance: preset.performance, camera: preset.camera, editing: preset.editing, sound: preset.sound, avoid: preset.avoid,
  };
}

export function directorStyleAiContext(p: ProjectContext): string {
  const resolved = resolveDirectorStyle(p.config.visual_style);
  if (!resolved.userQuery) return '项目导演风格：未指定。不要凭空套用具体作品风格。';
  return `项目导演风格上下文（供 H3Mise AI 取舍，不要机械粘贴全部字段）：\n${JSON.stringify({
    user_style_intent: resolved.userQuery,
    resolved_preset: resolved.preset ? { id: resolved.preset.id, name: resolved.preset.name } : null,
    style_directives: resolved.preset ? directives(resolved.preset) : { custom_intent: [resolved.userQuery] },
    rules: ['只选择与当前 Shot 有关的属性', '转写为具体可见可听的 H3 导演描述', '不在最终 Prompt 保留被模仿作品名', '不覆盖角色身份、资产、故事事实、连续性或用户明确镜头要求', '每个 Shot 最多一个主要镜头运动'],
  })}`;
}

export function directorStylePromptDirective(p: ProjectContext): string {
  const resolved = resolveDirectorStyle(p.config.visual_style);
  if (!resolved.userQuery) return '';
  if (!resolved.preset) return resolved.userQuery;
  return Object.entries(directives(resolved.preset)).map(([key, values]) => `${key}: ${values.join('; ')}`).join(' | ');
}
