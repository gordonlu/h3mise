<script setup lang="ts">
import { computed } from 'vue';
import { H3_MODE_LABEL } from '@h3mise/shared';
import type {
  DirectorPlanVersion,
  H3Mode,
  NextAction,
  PreflightReport,
  PromptVersion,
  ProviderStatus,
  ReferenceBinding,
  Shot,
  ShotGuideState,
  Take,
} from '@h3mise/shared';

type WorkspaceTarget = 'plan' | 'references' | 'prompt' | 'preflight' | 'takes';

const REQUIREMENT_LABEL: Record<string, string> = {
  character_state: '角色状态',
  first_frame: '首帧',
  last_frame: '尾帧',
  ref_images: 'RefImages 参考图',
};

const MODE_PURPOSE: Record<H3Mode, string> = {
  t2va: '纯文字生成',
  i2va: '从首帧开始',
  l2va: '控制结束画面',
  fl2va: '控制开头和结尾',
  ref2va: '多参考生成',
};

const props = defineProps<{
  shot: Shot;
  plan: DirectorPlanVersion | null;
  bindings: ReferenceBinding[];
  requirements: Array<{ level: string; kind: string; label: string; detail: string }>;
  prompt: PromptVersion | null;
  reports: PreflightReport[];
  provider: ProviderStatus | null;
  takes: Take[];
  selectedTake: Take | null;
  guide: ShotGuideState;
  nextAction: NextAction;
  nextActionLabel: string;
}>();

const emit = defineEmits<{
  open: [target: WorkspaceTarget];
  action: [action: NextAction];
}>();

const missingRequirements = computed(() => props.requirements.filter((item) => item.level === 'required'));
const latestMatchingReport = computed(() => props.prompt
  ? props.reports.find((report) => report.promptVersionId === props.prompt?.id) ?? null
  : null);
const preflightReady = computed(() => Boolean(latestMatchingReport.value && !latestMatchingReport.value.blocked));

const planRows = computed(() => {
  const plan = props.plan?.plan;
  return [
    { label: '目标', value: plan?.intent.visualThesis || plan?.intent.dramaticGoal || props.shot.purpose },
    { label: '主体动作', value: plan?.subject.action || plan?.performance.primaryAction },
    { label: '摄影机', value: plan?.camera.dominantBehavior || plan?.camera.lensIntent },
    { label: '结束状态', value: plan?.intent.endState || plan?.continuity.plannedEndState },
  ];
});

const referenceSummary = computed(() => {
  const roles = props.bindings.flatMap((binding) => binding.roles);
  const mode = props.shot.h3Mode ?? 't2va';
  if (mode === 'ref2va') {
    const images = props.bindings.filter((binding) => binding.type === 'image' && !binding.roles.some((role) => role === 'first_frame' || role === 'last_frame')).length;
    const audios = props.bindings.filter((binding) => binding.type === 'audio').length;
    return [
      { label: `RefImages ×${images}`, ready: images > 0 },
      { label: `RefAudios ×${audios}`, ready: audios > 0 },
    ];
  }
  if (mode === 'i2va') return [{ label: 'FirstFrame 首帧', ready: roles.includes('first_frame') }];
  if (mode === 'l2va') return [{ label: 'LastFrame 尾帧', ready: roles.includes('last_frame') }];
  if (mode === 'fl2va') return [
    { label: 'FirstFrame 首帧', ready: roles.includes('first_frame') },
    { label: 'LastFrame 尾帧', ready: roles.includes('last_frame') },
  ];
  return [{ label: '无需参考素材', ready: true }];
});

const recommendedMode = computed<H3Mode | null>(() => {
  const supported = props.provider?.capabilities?.supportedModes;
  if (!supported) return null;
  const roles = new Set(props.bindings.flatMap((binding) => binding.roles));
  const hasRefImage = props.bindings.some((binding) => binding.type === 'image' && !binding.roles.some((role) => role === 'first_frame' || role === 'last_frame'));
  const candidates: H3Mode[] = [];
  if (roles.has('first_frame') && roles.has('last_frame')) candidates.push('fl2va');
  if (roles.has('first_frame')) candidates.push('i2va');
  if (roles.has('last_frame')) candidates.push('l2va');
  if (hasRefImage) candidates.push('ref2va');
  candidates.push('t2va');
  return candidates.find((mode) => supported.includes(mode)) ?? null;
});

const currentModeSupported = computed(() => {
  const supported = props.provider?.capabilities?.supportedModes;
  return supported ? supported.includes(props.shot.h3Mode ?? 't2va') : null;
});
const workbenchRenderReady = computed(() => props.guide.renderReady && currentModeSupported.value === true);
</script>

<template>
  <div class="workspace">
    <section class="next-card">
      <div>
        <div class="eyebrow">从这里开始</div>
        <strong>{{ nextAction.title }}</strong>
        <p>{{ nextAction.description }}</p>
      </div>
      <button class="primary" @click="emit('action', nextAction)">{{ nextActionLabel }}</button>
    </section>

    <section class="workspace-section">
      <div class="section-head">
        <div>
          <div class="eyebrow">镜头设计</div>
          <strong>这个镜头怎么拍</strong>
        </div>
        <span :class="['badge', guide.designReady ? 'ok' : 'warn']">{{ guide.designReady ? '已准备' : '待完善' }}</span>
      </div>
      <dl class="summary-list">
        <div v-for="row in planRows" :key="row.label">
          <dt>{{ row.label }}</dt>
          <dd :class="{ muted: !row.value }">{{ row.value || '尚未填写' }}</dd>
        </div>
      </dl>
      <button class="sm" @click="emit('open', 'plan')">{{ guide.designReady ? '编辑镜头设计' : '开始镜头设计' }} →</button>
    </section>

    <section class="workspace-section">
      <div class="section-head">
        <div>
          <div class="eyebrow">参考素材</div>
          <strong>{{ bindings.length ? `已绑定 ${bindings.length} 项` : '尚未绑定素材' }}</strong>
        </div>
        <span :class="['badge', missingRequirements.length ? 'bad' : 'ok']">
          {{ missingRequirements.length ? `缺 ${missingRequirements.length} 项` : '条件已满足' }}
        </span>
      </div>
      <div class="readiness-grid">
        <div v-for="item in referenceSummary" :key="item.label" :class="['readiness-item', { ready: item.ready }]">
          <span>{{ item.ready ? '✓' : '○' }}</span>{{ item.label }}
        </div>
      </div>
      <div v-if="missingRequirements.length" class="notice bad-notice">
        还需要：{{ missingRequirements.map((item) => REQUIREMENT_LABEL[item.kind] ?? item.label.replace(/ missing$/i, '')).join('、') }}
      </div>
      <div class="mode-recommendation">
        <span class="muted">建议模式</span>
        <strong v-if="recommendedMode">{{ H3_MODE_LABEL[recommendedMode] }}</strong>
        <strong v-else>暂无可执行推荐</strong>
        <span v-if="!provider?.capabilities" class="muted">当前 Provider 能力未确认</span>
        <span v-else class="muted">基于已绑定素材与 {{ provider.name }} 能力</span>
      </div>
      <button class="sm" @click="emit('open', 'references')">添加 / 管理素材 →</button>
    </section>

    <section class="workspace-section generation-section">
      <div class="section-head">
        <div>
          <div class="eyebrow">生成</div>
          <strong>{{ provider?.name ?? 'Provider 未配置' }}</strong>
        </div>
        <span v-if="currentModeSupported !== true" :class="['badge', currentModeSupported === false ? 'bad' : 'warn']">
          {{ currentModeSupported === false ? '当前模式不受支持' : '生成能力未确认' }}
        </span>
      </div>
      <div class="generation-spec">
        <span>{{ MODE_PURPOSE[shot.h3Mode ?? 't2va'] }} · {{ H3_MODE_LABEL[shot.h3Mode ?? 't2va'] }}</span>
        <i />
        <span>{{ shot.durationSeconds }}s</span>
        <i />
        <span>{{ shot.aspectRatio }}</span>
        <i />
        <span>1 个新 Take</span>
      </div>
      <div class="check-list">
        <button class="check-row" @click="emit('open', 'prompt')">
          <span :class="['check-mark', prompt ? 'ready' : 'waiting']">{{ prompt ? '✓' : '○' }}</span>
          <span>提示词{{ prompt ? '已准备' : '待准备' }}</span>
          <span class="muted">查看 →</span>
        </button>
        <button class="check-row" @click="emit('open', 'preflight')">
          <span :class="['check-mark', preflightReady ? 'ready' : latestMatchingReport?.blocked ? 'blocked' : 'waiting']">
            {{ preflightReady ? '✓' : latestMatchingReport?.blocked ? '!' : '○' }}
          </span>
          <span>生成检查{{ preflightReady ? '通过' : latestMatchingReport?.blocked ? '未通过' : '待运行' }}</span>
          <span class="muted">查看 →</span>
        </button>
      </div>
      <button class="primary generate-cta" :disabled="!workbenchRenderReady" @click="emit('open', 'preflight')">
        {{ workbenchRenderReady ? '生成视频 · 创建 1 个新 Take' : currentModeSupported === false ? '当前 Provider 不支持此模式' : '完成生成准备后可生成' }}
      </button>
      <p class="muted cta-note">生成前会再次校验最终参数；不会在此工作台自动提交付费任务。</p>
    </section>

    <section class="workspace-section">
      <div class="section-head">
        <div>
          <div class="eyebrow">Takes</div>
          <strong>{{ takes.length ? `${takes.length} 条生成结果` : '等待第一次生成' }}</strong>
        </div>
        <span :class="['badge', selectedTake ? 'ok' : takes.length ? 'warn' : 'no-dot']">
          {{ selectedTake ? '已选片' : takes.length ? '待选片' : '暂无' }}
        </span>
      </div>
      <p class="muted take-copy">
        {{ selectedTake ? `当前选择 ${selectedTake.id}` : takes.length ? '比较生成结果并选择最符合镜头意图的一条。' : '生成完成后，结果会进入下方 Takes 区域。' }}
      </p>
      <button class="sm" @click="emit('open', 'takes')">{{ takes.length ? '比较 Takes' : '查看 Takes 区域' }} →</button>
    </section>

  </div>
</template>

<style scoped>
.workspace { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.workspace-section { padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg-subtle); }
.section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.section-head strong { display: block; margin-top: 2px; font-size: 14px; }
.eyebrow { color: var(--accent-text); font-size: 10.5px; font-weight: 800; letter-spacing: 0.11em; text-transform: uppercase; }
.summary-list { margin: 0 0 12px; display: grid; gap: 8px; }
.summary-list > div { display: grid; grid-template-columns: 68px minmax(0, 1fr); gap: 10px; }
.summary-list dt { color: var(--text-3); font-size: 11px; }
.summary-list dd { margin: 0; color: var(--text-2); font-size: 12px; line-height: 1.45; }
.readiness-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px; }
.readiness-item { color: var(--text-3); font-size: 11.5px; }
.readiness-item span { display: inline-block; width: 18px; }
.readiness-item.ready { color: var(--ok); }
.notice { border-radius: 6px; padding: 7px 9px; margin-bottom: 10px; font-size: 11.5px; }
.bad-notice { color: var(--bad); background: var(--bad-soft); border: 1px solid color-mix(in srgb, var(--bad) 22%, transparent); }
.mode-recommendation { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: baseline; padding: 10px 0; border-top: 1px dashed var(--line-2); }
.mode-recommendation > :last-child { grid-column: 1 / -1; }
.generation-section { background: var(--bg-2); border-color: var(--accent-line); }
.generation-spec { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; font-family: var(--mono); font-size: 12px; color: var(--text-2); }
.generation-spec i { width: 3px; height: 3px; border-radius: 50%; background: var(--line-3); }
.check-list { display: grid; gap: 6px; margin-bottom: 12px; }
.check-row { width: 100%; display: grid; grid-template-columns: 20px 1fr auto; align-items: center; text-align: left; padding: 7px 9px; background: var(--bg-subtle); box-shadow: none; border-color: var(--line); }
.check-mark { font-weight: 700; }
.check-mark.ready { color: var(--ok); }
.check-mark.waiting { color: var(--text-3); }
.check-mark.blocked { color: var(--bad); }
.generate-cta { width: 100%; }
.cta-note { margin: 7px 0 0; text-align: center; line-height: 1.4; }
.take-copy { margin: 0 0 10px; }
.next-card { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; gap: 18px; padding: 18px 20px; border-radius: 8px; background: var(--accent-soft); border: 1px solid var(--accent-line); }
.next-card strong { display: block; margin-top: 2px; font-size: 16px; }
.next-card p { margin: 3px 0 0; color: var(--text-2); font-size: 12px; line-height: 1.5; }
.next-card button { flex: none; }
</style>
