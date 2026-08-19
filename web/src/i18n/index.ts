// H3Mise i18n — zero-dependency, dictionary-based. zh-CN is the default
// authoring language; en is a growing backfill. UI strings should prefer t()
// here; product terms (Take / Prompt / DirectorPlan / CharacterState /
// StoryBeat / Preflight…) stay romanized by design.

export const zh = {
  brand: { mark: 'H3', name: 'Mise' },
  nav: { story: '故事', shots: '镜头', assets: '资产', timeline: '时间线', projects: '项目', settings: '设置' },
  common: {
    renderQueue: '渲染队列',
    cancel: '取消',
    confirm: '确定',
    delete: '删除',
    create: '创建',
    save: '保存',
    close: '关闭',
    add: '添加',
    remove: '移除',
    loading: '加载中…',
    empty: '空',
  },
  pages: {
    story: {
      title: '故事',
      subtitle: '故事事实层（不是 Prompt）',
      beats: 'StoryBeats',
      aiSplit: 'AI 拆解',
      aiSplitting: 'AI 拆解中…',
      aiSplitEmpty: '先填写故事正文，才能用 AI 拆解',
      aiSplitConfirm: '将按故事正文拆解为 StoryBeat，可在拆解后手工调整。继续？',
      newBeat: '＋ Beat',
      noBeatsTitle: '还没有 Beat',
      noBeatsDesc: '手工添加 Beat，或在 Shots 页粘贴外部 AI 的 Shot List；配置内置 AI 后可一键拆解。',
      beatSummary: 'Beat 摘要 / 剧情事实',
      location: '地点',
      timeOfDay: '时间',
      weather: '天气',
      splitShots: '已拆 Shot',
      deleteBeatTitle: '删除 StoryBeat？',
      deleteBeatLinked: '该 Beat 已关联 {n} 个 Shot（关联会被解除，Shot 本身保留）。',
      deleteBeatMsg: '删除后不可恢复。',
      beatDeleted: 'Beat 已删除',
      aiDone: 'AI 拆解完成：新增 {n} 个 StoryBeat（可手工调整）',
      aiFailed: 'AI 拆解失败：{msg}',
      titleField: '标题',
      logline: 'Logline 一句话',
      synopsis: 'Synopsis 梗概',
      body: '正文 / 剧本 / 小说片段（供拆解与外部 AI 使用）',
    },
    shots: {
      title: '镜头板',
      shotsCount: '{n} 个镜头',
    },
    assets: {
      title: '资产',
      subtitle: '资产由 Shot 需求驱动：Entity 是「谁 / 什么」，CharacterState 是「当前剧情状态」，MediaAsset 通过 ReferenceBinding 承担用途。',
      tabs: { entities: '实体', states: '角色状态', media: '媒体资产', bindings: '全局绑定' },
    },
    timeline: {
      title: '时间线',
      clipsCount: '{n} clips · {s}s',
      export: 'Export（ffmpeg）',
      exporting: '导出中…',
    },
    settings: { title: '设置' },
    projects: { title: '项目' },
  },
};

export const en: typeof zh = {
  brand: { mark: 'H3', name: 'Mise' },
  nav: { story: 'Story', shots: 'Shots', assets: 'Assets', timeline: 'Timeline', projects: 'Projects', settings: 'Settings' },
  common: {
    renderQueue: 'Render Queue',
    cancel: 'Cancel',
    confirm: 'Confirm',
    delete: 'Delete',
    create: 'Create',
    save: 'Save',
    close: 'Close',
    add: 'Add',
    remove: 'Remove',
    loading: 'Loading…',
    empty: 'Empty',
  },
  pages: {
    story: {
      title: 'Story',
      subtitle: 'Story facts (not a prompt)',
      beats: 'StoryBeats',
      aiSplit: 'AI Split',
      aiSplitting: 'Splitting…',
      aiSplitEmpty: 'Fill in the story body first to use AI split',
      aiSplitConfirm: 'Split the story body into StoryBeats; you can adjust afterwards. Continue?',
      newBeat: '+ Beat',
      noBeatsTitle: 'No beats yet',
      noBeatsDesc: 'Add beats manually, or paste an external AI Shot List on the Shots page; built-in AI can split for you once configured.',
      beatSummary: 'Beat summary / story facts',
      location: 'Location',
      timeOfDay: 'Time',
      weather: 'Weather',
      splitShots: 'Linked shots',
      deleteBeatTitle: 'Delete StoryBeat?',
      deleteBeatLinked: 'This beat is linked to {n} shots (links are removed, shots are kept).',
      deleteBeatMsg: 'This cannot be undone.',
      beatDeleted: 'Beat deleted',
      aiDone: 'AI split done: {n} new StoryBeats (adjust manually)',
      aiFailed: 'AI split failed: {msg}',
      titleField: 'Title',
      logline: 'Logline',
      synopsis: 'Synopsis',
      body: 'Body / script / novel excerpt (for split & external AI)',
    },
    shots: {
      title: 'Shotboard',
      shotsCount: '{n} shots',
    },
    assets: {
      title: 'Assets',
      subtitle: 'Assets are driven by shot requirements: Entity is "who / what", CharacterState is "current story state", MediaAsset serves a purpose via ReferenceBinding.',
      tabs: { entities: 'Entities', states: 'CharacterStates', media: 'Media', bindings: 'Global bindings' },
    },
    timeline: {
      title: 'Timeline',
      clipsCount: '{n} clips · {s}s',
      export: 'Export (ffmpeg)',
      exporting: 'Exporting…',
    },
    settings: { title: 'Settings' },
    projects: { title: 'Projects' },
  },
};

export type Locale = 'zh' | 'en';
export const dictionaries: Record<Locale, typeof zh> = { zh, en };

/** Flat lookup with {placeholder} substitution. */
export function translate(locale: Locale, path: string, vars?: Record<string, string | number>): string {
  const dict = dictionaries[locale] ?? zh;
  const val = path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), dict);
  let out = typeof val === 'string' ? val : path;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}