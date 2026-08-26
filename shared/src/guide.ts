// Guide presentation model. Everything here is derived from existing domain
// facts; no guide state is persisted.

export type GuideStepState = 'complete' | 'current' | 'upcoming' | 'attention';

export interface GuideShotSnapshot {
  id: string;
  order: number;
  title: string;
  hasDirectorPlan: boolean;
  missingReferences: string[];
  hasPrompt: boolean;
  /** null means no current preflight result is available. */
  preflightBlocked: boolean | null;
  activeRenderJobId: string | null;
  takeCount: number;
  selectedTakeId: string | null;
}

export interface ShotGuideState {
  designReady: boolean;
  referencesReady: boolean;
  promptReady: boolean;
  renderReady: boolean;
  rendering: boolean;
  hasTakes: boolean;
  selectedTakeId: string | null;
  steps: Array<{
    key: 'design' | 'references' | 'generate' | 'select';
    label: string;
    state: GuideStepState;
  }>;
}

export type NextAction =
  | { kind: 'design_shot'; shotId: string; title: string; description: string; to: string }
  | { kind: 'add_reference'; shotId: string; title: string; description: string; to: string }
  | { kind: 'review_prompt'; shotId: string; title: string; description: string; to: string }
  | { kind: 'run_preflight'; shotId: string; title: string; description: string; to: string }
  | { kind: 'render'; shotId: string; title: string; description: string; to: string }
  | { kind: 'wait_render'; shotId: string; renderJobId: string; title: string; description: string; to: string }
  | { kind: 'select_take'; shotId: string; title: string; description: string; to: string }
  | { kind: 'continue_next_shot'; shotId: string; title: string; description: string; to: string }
  | { kind: 'open_timeline'; title: string; description: string; to: string }
  | { kind: 'export'; title: string; description: string; to: string }
  | { kind: 'complete'; title: string; description: string; to: string };

function activeStep(snapshot: GuideShotSnapshot): ShotGuideState['steps'][number]['key'] {
  if (snapshot.selectedTakeId || snapshot.takeCount > 0) return 'select';
  if (snapshot.activeRenderJobId || snapshot.hasPrompt) return 'generate';
  if (!snapshot.hasDirectorPlan) return 'design';
  if (snapshot.missingReferences.length > 0) return 'references';
  return 'generate';
}

export function deriveShotGuideState(snapshot: GuideShotSnapshot): ShotGuideState {
  const current = activeStep(snapshot);
  const ready = {
    design: snapshot.hasDirectorPlan,
    references: snapshot.missingReferences.length === 0,
    generate: snapshot.takeCount > 0,
    select: snapshot.selectedTakeId !== null,
  };
  const order = ['design', 'references', 'generate', 'select'] as const;
  const currentIndex = order.indexOf(current);

  return {
    designReady: ready.design,
    referencesReady: ready.references,
    promptReady: snapshot.hasPrompt,
    renderReady: snapshot.hasPrompt && ready.references && snapshot.preflightBlocked === false && !snapshot.activeRenderJobId,
    rendering: snapshot.activeRenderJobId !== null,
    hasTakes: snapshot.takeCount > 0,
    selectedTakeId: snapshot.selectedTakeId,
    steps: order.map((key, index) => ({
      key,
      label: key === 'design' ? '镜头设计' : key === 'references' ? '参考素材' : key === 'generate' ? '生成' : '选片',
      state: ready[key] ? 'complete' : key === current ? 'current' : index < currentIndex ? 'attention' : 'upcoming',
    })),
  };
}

export function deriveNextAction(snapshot: GuideShotSnapshot, nextShotId?: string | null): NextAction {
  const shotTo = `/shots/${snapshot.id}`;
  if (snapshot.activeRenderJobId) {
    return {
      kind: 'wait_render', shotId: snapshot.id, renderJobId: snapshot.activeRenderJobId,
      title: `${snapshot.title} 正在生成`, description: '任务已提交，你可以先处理其他 Shot。', to: shotTo,
    };
  }
  if (snapshot.takeCount > 0 && !snapshot.selectedTakeId) {
    return {
      kind: 'select_take', shotId: snapshot.id, title: '选择一个 Take',
      description: `${snapshot.title} 已生成 ${snapshot.takeCount} 个 Take，等待选片。`, to: `${shotTo}#takes`,
    };
  }
  if (snapshot.selectedTakeId) {
    if (nextShotId) {
      return {
        kind: 'continue_next_shot', shotId: nextShotId, title: '继续下一个镜头',
        description: `${snapshot.title} 已选片，可以继续制作下一个 Shot。`, to: `/shots/${nextShotId}`,
      };
    }
    return { kind: 'open_timeline', title: '进入成片编排', description: '所有 Shot 都已选片，可以开始编排成片。', to: '/timeline' };
  }
  if (!snapshot.hasDirectorPlan) {
    return { kind: 'design_shot', shotId: snapshot.id, title: '完成镜头设计', description: '先明确镜头目标、主体动作、摄影机和结束状态。', to: `${shotTo}?guide=design` };
  }
  if (snapshot.missingReferences.length > 0) {
    return {
      kind: 'add_reference', shotId: snapshot.id, title: `添加${snapshot.missingReferences[0]}`,
      description: `当前生成条件还缺：${snapshot.missingReferences.join('、')}。`, to: `${shotTo}?guide=references`,
    };
  }
  if (!snapshot.hasPrompt) {
    return { kind: 'review_prompt', shotId: snapshot.id, title: '准备生成 Prompt', description: '镜头设计和素材已准备，下一步生成或导入 Prompt。', to: `${shotTo}?guide=prompt` };
  }
  if (snapshot.preflightBlocked !== false) {
    return { kind: 'run_preflight', shotId: snapshot.id, title: '完成生成检查', description: '确认 Provider、素材和最终生成参数是否可以执行。', to: `${shotTo}?guide=preflight` };
  }
  return { kind: 'render', shotId: snapshot.id, title: '生成视频', description: '生成检查已通过，确认本次参数后即可创建新的 Take。', to: `${shotTo}?guide=preflight` };
}

export interface ProjectGuideSummary {
  shotCount: number;
  selectedTakeCount: number;
  renderingCount: number;
  awaitingSelectionCount: number;
  missingReferencesCount: number;
  notStartedCount: number;
  timelineClipCount: number;
  exportCount: number;
  attention: NextAction;
}

export function deriveProjectAttention(shots: GuideShotSnapshot[], timelineClipCount = 0, exportCount = 0): ProjectGuideSummary {
  const ordered = [...shots].sort((a, b) => a.order - b.order);
  const unfinished = ordered.filter((shot) => !shot.selectedTakeId);
  const target =
    unfinished.find((shot) => shot.takeCount > 0 && !shot.selectedTakeId) ??
    unfinished.find((shot) => shot.missingReferences.length > 0) ??
    unfinished.find((shot) => shot.preflightBlocked === false && shot.hasPrompt) ??
    unfinished[0];
  const attention = target
    ? deriveNextAction(target, unfinished.find((shot) => shot.order > target.order)?.id ?? null)
    : timelineClipCount < ordered.length
      ? ({ kind: 'open_timeline', title: '进入成片编排', description: '所有 Shot 都已选片，可以加入 Timeline。', to: '/timeline' } as const)
      : exportCount === 0
        ? ({ kind: 'export', title: '导出成片', description: 'Timeline 已准备，可以检查并导出最终视频。', to: '/timeline' } as const)
        : ({ kind: 'complete', title: '成片已导出', description: '项目已有可播放的导出成片，也可以继续调整并重新导出。', to: '/timeline' } as const);

  return {
    shotCount: ordered.length,
    selectedTakeCount: ordered.filter((shot) => shot.selectedTakeId).length,
    renderingCount: ordered.filter((shot) => shot.activeRenderJobId).length,
    awaitingSelectionCount: ordered.filter((shot) => shot.takeCount > 0 && !shot.selectedTakeId).length,
    missingReferencesCount: unfinished.filter((shot) => shot.missingReferences.length > 0).length,
    notStartedCount: unfinished.filter((shot) => !shot.hasDirectorPlan && !shot.hasPrompt && shot.takeCount === 0).length,
    timelineClipCount,
    exportCount,
    attention,
  };
}
