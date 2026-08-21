<script setup lang="ts">
import { ref, watch, computed, toRaw } from 'vue';
import { emptyDirectorPlan } from '@h3mise/shared';
import type { DirectorPlan } from '@h3mise/shared';

const props = defineProps<{ plan: DirectorPlan; aiEnabled: boolean; onAiSuggest: (section: string) => void; aiBusy?: boolean }>();
const emit = defineEmits<{ save: [plan: DirectorPlan]; paste: []; dirtyChange: [dirty: boolean] }>();

const draft = ref<DirectorPlan>(emptyDirectorPlan());
const savedSnapshot = ref('');

watch(
  () => props.plan,
  (p) => {
    draft.value = structuredClone(toRaw(p));
    savedSnapshot.value = JSON.stringify(p);
  },
  { immediate: true, deep: true },
);

const isDirty = computed(() => JSON.stringify(draft.value) !== savedSnapshot.value);
watch(isDirty, (d) => emit('dirtyChange', d), { immediate: true });

interface FieldDef {
  path: readonly string[];
  cn: string;
  en: string;
  type: string;
  options?: readonly string[];
  placeholder?: string;
}

interface SectionDef {
  key: string;
  cn: string;
  en: string;
  ai?: boolean;
  fields: FieldDef[];
}

const sections: SectionDef[] = [
  {
    key: 'intent', cn: '意图', en: 'Intent', ai: true,
    fields: [
      { path: ['intent', 'shotFunction'], cn: '镜头功能', en: 'Shot Function', type: 'select', options: ['establishing', 'wide', 'medium', 'closeup', 'insert', 'reaction', 'action', 'transition', 'montage', 'pov', 'aerial', 'dialogue', 'other'] },
      { path: ['intent', 'visualThesis'], cn: '视觉主题', en: 'Visual Thesis', type: 'textarea', placeholder: '这个镜头在画面上要表达什么' },
      { path: ['intent', 'dramaticGoal'], cn: '戏剧目标', en: 'Dramatic Goal', type: 'textarea' },
      { path: ['intent', 'peak'], cn: '峰值时刻', en: 'Peak', type: 'textarea', placeholder: '情绪/动作的最高点发生在何时' },
      { path: ['intent', 'endState'], cn: '结束状态', en: 'End State', type: 'textarea', placeholder: '镜头落幅时画面停在哪里' },
    ],
  },
  {
    key: 'subject', cn: '主体', en: 'Subject',
    fields: [
      { path: ['subject', 'primarySubject'], cn: '主主体', en: 'Primary Subject', type: 'text' },
      { path: ['subject', 'action'], cn: '动作', en: 'Action', type: 'textarea' },
      { path: ['subject', 'primaryMotionOwner'], cn: '运动主体', en: 'Motion Owner', type: 'text' },
    ],
  },
  {
    key: 'blocking', cn: '走位', en: 'Blocking',
    fields: [
      { path: ['blocking', 'startPosition'], cn: '起始位置', en: 'Start Position', type: 'text' },
      { path: ['blocking', 'endPosition'], cn: '结束位置', en: 'End Position', type: 'text' },
      { path: ['blocking', 'facing'], cn: '朝向', en: 'Facing', type: 'text' },
      { path: ['blocking', 'movementAxis'], cn: '运动轴', en: 'Movement Axis', type: 'text' },
      { path: ['blocking', 'travelPath'], cn: '路径', en: 'Travel Path', type: 'text' },
      { path: ['blocking', 'spatialRelationships'], cn: '空间关系', en: 'Spatial Relationships', type: 'text' },
    ],
  },
  {
    key: 'camera', cn: '摄影机', en: 'Camera', ai: true,
    fields: [
      { path: ['camera', 'shotSizeStart'], cn: '起幅景别', en: 'Shot Size Start', type: 'text', placeholder: '如 wide / medium / close-up' },
      { path: ['camera', 'shotSizePeak'], cn: '峰值景别', en: 'Shot Size Peak', type: 'text' },
      { path: ['camera', 'shotSizeEnd'], cn: '落幅景别', en: 'Shot Size End', type: 'text' },
      { path: ['camera', 'geometry'], cn: '机位几何', en: 'Geometry', type: 'text' },
      { path: ['camera', 'lensIntent'], cn: '镜头意图', en: 'Lens Intent', type: 'text', placeholder: '如 35mm  handheld intimacy' },
      { path: ['camera', 'dominantBehavior'], cn: '主导运动', en: 'Dominant Behavior', type: 'text', placeholder: '如 slow push-in / lateral dolly' },
      { path: ['camera', 'trigger'], cn: '运动触发', en: 'Trigger', type: 'text' },
      { path: ['camera', 'speedRelation'], cn: '速度关系', en: 'Speed Relation', type: 'text', placeholder: '摄影机与主体的速度关系' },
      { path: ['camera', 'stopCondition'], cn: '停止条件', en: 'Stop Condition', type: 'text' },
    ],
  },
  {
    key: 'performance', cn: '表演', en: 'Performance', ai: true,
    fields: [
      { path: ['performance', 'objective'], cn: '目标', en: 'Objective', type: 'text' },
      { path: ['performance', 'obstacle'], cn: '障碍', en: 'Obstacle', type: 'text' },
      { path: ['performance', 'tactic'], cn: '策略', en: 'Tactic', type: 'text' },
      { path: ['performance', 'performanceTurn'], cn: '转折', en: 'Turn', type: 'text' },
      { path: ['performance', 'movementQuality', 'weight'], cn: '重量感', en: 'Weight', type: 'text', placeholder: '如 heavy / light' },
      { path: ['performance', 'movementQuality', 'time'], cn: '时间感', en: 'Time', type: 'text', placeholder: '如 sudden / sustained' },
      { path: ['performance', 'movementQuality', 'space'], cn: '空间感', en: 'Space', type: 'text', placeholder: '如 direct / indirect' },
      { path: ['performance', 'movementQuality', 'flow'], cn: '流动感', en: 'Flow', type: 'text', placeholder: '如 bound / free' },
      { path: ['performance', 'anticipation'], cn: '预备', en: 'Anticipation', type: 'text' },
      { path: ['performance', 'primaryAction'], cn: '主动作', en: 'Primary Action', type: 'text' },
      { path: ['performance', 'followThrough'], cn: '缓冲', en: 'Follow-through', type: 'text' },
      { path: ['performance', 'recovery'], cn: '还原', en: 'Recovery', type: 'text' },
      { path: ['performance', 'gaze'], cn: '视线', en: 'Gaze', type: 'text' },
      { path: ['performance', 'endPose'], cn: '结束姿势', en: 'End Pose', type: 'text' },
    ],
  },
  {
    key: 'environment', cn: '环境', en: 'Environment',
    fields: [
      { path: ['environment', 'location'], cn: '地点', en: 'Location', type: 'text' },
      { path: ['environment', 'weather'], cn: '天气', en: 'Weather', type: 'text' },
      { path: ['environment', 'medium'], cn: '介质', en: 'Medium', type: 'text', placeholder: '如 rain / fog / dust' },
      { path: ['environment', 'wind'], cn: '风', en: 'Wind', type: 'text' },
      { path: ['environment', 'lighting'], cn: '灯光', en: 'Lighting', type: 'text' },
      { path: ['environment', 'foreground'], cn: '前景', en: 'Foreground', type: 'text' },
      { path: ['environment', 'midground'], cn: '中景', en: 'Midground', type: 'text' },
      { path: ['environment', 'background'], cn: '背景', en: 'Background', type: 'text' },
    ],
  },
  {
    key: 'reality', cn: '现实规则', en: 'Reality', ai: true,
    fields: [
      { path: ['reality', 'mode'], cn: '模式', en: 'Mode', type: 'select', options: ['strict_realism', 'plausible_stylized', 'deliberate_fantasy'] },
      { path: ['reality', 'constraints'], cn: '约束（每行一条）', en: 'Constraints', type: 'list', placeholder: '如：角色不会飞；车辆遵守惯性' },
    ],
  },
  {
    key: 'continuity', cn: '连续性（计划）', en: 'Continuity',
    fields: [
      { path: ['continuity', 'plannedStartState'], cn: '计划起始状态', en: 'Planned Start State', type: 'textarea' },
      { path: ['continuity', 'plannedEndState'], cn: '计划结束状态', en: 'Planned End State', type: 'textarea' },
    ],
  },
  {
    key: 'generation', cn: '生成参数', en: 'Generation',
    fields: [
      { path: ['generation', 'requestedMode'], cn: '请求模式', en: 'Requested Mode', type: 'select', options: ['', 't2va', 'i2va', 'fl2va', 'l2va', 'ref2va'] },
      { path: ['generation', 'durationSeconds'], cn: '时长 (s)', en: 'Duration', type: 'number' },
      { path: ['generation', 'aspectRatio'], cn: '画幅', en: 'Aspect Ratio', type: 'text' },
      { path: ['generation', 'audioIntent'], cn: '声音设计', en: 'Audio Intent', type: 'textarea' },
    ],
  },
];

// Accordion state persisted across shots/sessions; only Intent open by default.
const STORAGE_KEY = 'h3mise-plan-sections';
const open = ref<Set<string>>(new Set(['intent']));
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[];
  if (Array.isArray(saved) && saved.length) open.value = new Set(saved);
} catch { /* ignore */ }

function toggleSection(key: string) {
  const next = new Set(open.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  open.value = next;
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
}

/** Sections that have any content — hint badge on collapsed headers. */
function filledCount(sec: SectionDef): number {
  let n = 0;
  for (const f of sec.fields) {
    const v = fieldValue(f.path);
    if (Array.isArray(v) ? v.length : String(v ?? '').trim() !== '') n++;
  }
  return n;
}

function fieldValue(path: readonly string[]): string | number | string[] {
  let v: unknown = draft.value;
  for (const k of path) v = (v as Record<string, unknown>)?.[k];
  return (v as string | number | string[]) ?? '';
}

function setField(path: readonly string[], value: string | number | string[]) {
  let v: Record<string, unknown> = draft.value as never;
  for (const k of path.slice(0, -1)) v = (v[k] ??= {}) as Record<string, unknown>;
  v[path.at(-1)!] = value;
}

function save() {
  emit('save', structuredClone(toRaw(draft.value)));
}
</script>

<template>
  <div class="plan-editor col">
    <div class="spread editor-bar">
      <div class="row">
        <span class="muted">DirectorPlan <span class="mono">v{{ draft.version }}</span></span>
        <span v-if="isDirty" class="badge warn" title="有未保存的修改">● 未保存</span>
        <span v-else class="badge ok">已保存</span>
      </div>
      <div class="row">
        <button v-if="aiEnabled" class="sm" :disabled="aiBusy" @click="props.onAiSuggest('full')">{{ aiBusy ? 'AI 处理中…' : 'AI 建议全计划' }}</button>
        <button class="sm" @click="emit('paste')">粘贴外部 AI</button>
        <button class="primary sm" :class="{ pulse: isDirty }" @click="save">保存为新版本</button>
      </div>
    </div>

    <div v-for="sec in sections" :key="sec.key" class="panel section" :class="{ open: open.has(sec.key) }">
      <div class="sec-head" @click="toggleSection(sec.key)">
        <span class="chev">{{ open.has(sec.key) ? '▾' : '▸' }}</span>
        <span class="sec-cn">{{ sec.cn }}</span>
        <span class="sec-en">{{ sec.en }}</span>
        <span v-if="!open.has(sec.key) && filledCount(sec)" class="badge accent no-dot">{{ filledCount(sec) }} 项已填</span>
        <span class="grow" />
        <button v-if="sec.ai && aiEnabled" class="sm ghost" :disabled="aiBusy" @click.stop="props.onAiSuggest(sec.key)">{{ aiBusy ? 'AI 处理中…' : 'AI 建议' }}</button>
      </div>
      <div v-if="open.has(sec.key)" class="panel-body grid two" :class="{ 'intent-grid': sec.key === 'intent' }">
        <label v-for="f in sec.fields" :key="f.path.join('.')" class="field">
          <span class="f-label">{{ f.cn }} <span class="f-en">{{ f.en }}</span></span>
          <select v-if="f.type === 'select'" :value="fieldValue(f.path)" @change="setField(f.path, ($event.target as HTMLSelectElement).value)">
            <option v-for="o in f.options" :key="o" :value="o">{{ o || '—' }}</option>
          </select>
          <textarea v-else-if="f.type === 'textarea'" :value="fieldValue(f.path)" rows="2" :placeholder="f.placeholder" @input="setField(f.path, ($event.target as HTMLTextAreaElement).value)" />
          <input v-else-if="f.type === 'number'" type="number" :value="fieldValue(f.path)" :placeholder="f.placeholder" @input="setField(f.path, Number(($event.target as HTMLInputElement).value))" />
          <template v-else-if="f.type === 'list'">
            <textarea :value="(fieldValue(f.path) as string[]).join('\n')" rows="2" :placeholder="f.placeholder" @input="setField(f.path, ($event.target as HTMLTextAreaElement).value.split('\n').filter(Boolean))" />
          </template>
          <input v-else :value="fieldValue(f.path)" :placeholder="f.placeholder" @input="setField(f.path, ($event.target as HTMLInputElement).value)" />
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.two { grid-template-columns: 1fr 1fr; }
.intent-grid { align-items: stretch; }
.intent-grid .field { display: grid; grid-template-rows: 34px 68px; gap: 6px; margin-bottom: 0; }
.intent-grid .field > :is(input, select, textarea) { height: 68px; min-height: 68px; resize: none; }
.intent-grid .field:last-child { grid-column: 1 / -1; }
.editor-bar { position: sticky; top: 0; z-index: 5; background: var(--bg-2); padding: 4px 0 8px; }
.section { overflow: hidden; }
.sec-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; cursor: pointer; user-select: none; }
.sec-head:hover { background: var(--accent-soft); }
.chev { color: var(--text-3); font-size: 11px; width: 12px; }
.sec-cn { font-weight: 600; font-size: 13.5px; }
.sec-en { color: var(--text-3); font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; }
.f-label { display: flex; align-items: baseline; gap: 6px; }
.f-en { color: var(--text-3); font-size: 10.5px; font-weight: 400; }
.pulse { animation: savepulse 1.6s ease-in-out infinite; }
@keyframes savepulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(255, 108, 55, 0.0); } 50% { box-shadow: 0 0 0 4px rgba(255, 108, 55, 0.18); } }
</style>
