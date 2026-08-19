<script setup lang="ts">
import { ref, watch } from 'vue';
import { emptyDirectorPlan } from '@h3mise/shared';
import type { DirectorPlan, H3Mode } from '@h3mise/shared';

const props = defineProps<{ plan: DirectorPlan; aiEnabled: boolean; onAiSuggest: (section: string) => void }>();
const emit = defineEmits<{ save: [plan: DirectorPlan]; paste: [] }>();

const draft = ref<DirectorPlan>(emptyDirectorPlan());

watch(
  () => props.plan,
  (p) => {
    draft.value = structuredClone(p);
  },
  { immediate: true, deep: true },
);

interface SectionDef {
  key: string;
  title: string;
  ai?: boolean;
  fields: Array<{ path: readonly string[]; label: string; type: string; options?: readonly string[] }>;
}

const sections: SectionDef[] = [
  {
    key: 'intent',
    title: 'Intent 意图',
    ai: true,
    fields: [
      { path: ['intent', 'shotFunction'], label: 'Shot Function', type: 'select', options: ['establishing', 'wide', 'medium', 'closeup', 'insert', 'reaction', 'action', 'transition', 'montage', 'pov', 'aerial', 'dialogue', 'other'] },
      { path: ['intent', 'visualThesis'], label: 'Visual Thesis 视觉主题', type: 'textarea' },
      { path: ['intent', 'dramaticGoal'], label: 'Dramatic Goal 戏剧目标', type: 'textarea' },
      { path: ['intent', 'peak'], label: 'Peak 峰值时刻', type: 'textarea' },
      { path: ['intent', 'endState'], label: 'End State 结束状态', type: 'textarea' },
    ],
  },
  {
    key: 'subject',
    title: 'Subject 主体',
    fields: [
      { path: ['subject', 'primarySubject'], label: 'Primary Subject', type: 'text' },
      { path: ['subject', 'action'], label: 'Action 动作', type: 'textarea' },
      { path: ['subject', 'primaryMotionOwner'], label: 'Motion Owner 运动主体', type: 'text' },
    ],
  },
  {
    key: 'blocking',
    title: 'Blocking 走位',
    fields: [
      { path: ['blocking', 'startPosition'], label: 'Start Position', type: 'text' },
      { path: ['blocking', 'endPosition'], label: 'End Position', type: 'text' },
      { path: ['blocking', 'facing'], label: 'Facing 朝向', type: 'text' },
      { path: ['blocking', 'movementAxis'], label: 'Movement Axis 运动轴', type: 'text' },
      { path: ['blocking', 'travelPath'], label: 'Travel Path 路径', type: 'text' },
      { path: ['blocking', 'spatialRelationships'], label: 'Spatial Relationships 空间关系', type: 'text' },
    ],
  },
  {
    key: 'camera',
    title: 'Camera 摄影机',
    ai: true,
    fields: [
      { path: ['camera', 'shotSizeStart'], label: 'Shot Size Start', type: 'text' },
      { path: ['camera', 'shotSizePeak'], label: 'Shot Size Peak', type: 'text' },
      { path: ['camera', 'shotSizeEnd'], label: 'Shot Size End', type: 'text' },
      { path: ['camera', 'geometry'], label: 'Geometry 机位几何', type: 'text' },
      { path: ['camera', 'lensIntent'], label: 'Lens Intent 镜头意图', type: 'text' },
      { path: ['camera', 'dominantBehavior'], label: 'Dominant Behavior 主导运动', type: 'text' },
      { path: ['camera', 'trigger'], label: 'Trigger 触发', type: 'text' },
      { path: ['camera', 'speedRelation'], label: 'Speed Relation 速度关系', type: 'text' },
      { path: ['camera', 'stopCondition'], label: 'Stop Condition 停止条件', type: 'text' },
    ],
  },
  {
    key: 'performance',
    title: 'Performance 表演',
    ai: true,
    fields: [
      { path: ['performance', 'objective'], label: 'Objective 目标', type: 'text' },
      { path: ['performance', 'obstacle'], label: 'Obstacle 障碍', type: 'text' },
      { path: ['performance', 'tactic'], label: 'Tactic 策略', type: 'text' },
      { path: ['performance', 'performanceTurn'], label: 'Turn 转折', type: 'text' },
      { path: ['performance', 'movementQuality', 'weight'], label: 'Weight 重量', type: 'text' },
      { path: ['performance', 'movementQuality', 'time'], label: 'Time 时间', type: 'text' },
      { path: ['performance', 'movementQuality', 'space'], label: 'Space 空间', type: 'text' },
      { path: ['performance', 'movementQuality', 'flow'], label: 'Flow 流动', type: 'text' },
      { path: ['performance', 'anticipation'], label: 'Anticipation 预备', type: 'text' },
      { path: ['performance', 'primaryAction'], label: 'Primary Action 主动作', type: 'text' },
      { path: ['performance', 'followThrough'], label: 'Follow-through 缓冲', type: 'text' },
      { path: ['performance', 'recovery'], label: 'Recovery 还原', type: 'text' },
      { path: ['performance', 'gaze'], label: 'Gaze 视线', type: 'text' },
      { path: ['performance', 'endPose'], label: 'End Pose 结束姿势', type: 'text' },
    ],
  },
  {
    key: 'environment',
    title: 'Environment 环境',
    fields: [
      { path: ['environment', 'location'], label: 'Location 地点', type: 'text' },
      { path: ['environment', 'weather'], label: 'Weather 天气', type: 'text' },
      { path: ['environment', 'medium'], label: 'Medium 介质', type: 'text' },
      { path: ['environment', 'wind'], label: 'Wind 风', type: 'text' },
      { path: ['environment', 'lighting'], label: 'Lighting 灯光', type: 'text' },
      { path: ['environment', 'foreground'], label: 'Foreground 前景', type: 'text' },
      { path: ['environment', 'midground'], label: 'Midground 中景', type: 'text' },
      { path: ['environment', 'background'], label: 'Background 背景', type: 'text' },
    ],
  },
  {
    key: 'reality',
    title: 'Reality 现实规则',
    ai: true,
    fields: [
      { path: ['reality', 'mode'], label: 'Mode', type: 'select', options: ['strict_realism', 'plausible_stylized', 'deliberate_fantasy'] },
      { path: ['reality', 'constraints'], label: 'Constraints（每行一条）', type: 'list' },
    ],
  },
  {
    key: 'continuity',
    title: 'Continuity 连续性（计划）',
    fields: [
      { path: ['continuity', 'plannedStartState'], label: 'Planned Start State', type: 'textarea' },
      { path: ['continuity', 'plannedEndState'], label: 'Planned End State', type: 'textarea' },
    ],
  },
  {
    key: 'generation',
    title: 'Generation 生成参数',
    fields: [
      { path: ['generation', 'requestedMode'], label: 'Requested Mode', type: 'select', options: ['', 't2va', 'i2va', 'fl2va', 'l2va', 'ref2va'] },
      { path: ['generation', 'durationSeconds'], label: 'Duration (s)', type: 'number' },
      { path: ['generation', 'aspectRatio'], label: 'Aspect Ratio', type: 'text' },
      { path: ['generation', 'audioIntent'], label: 'Audio Intent（声音设计）', type: 'textarea' },
    ],
  },
];

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
  emit('save', structuredClone(draft.value));
}
</script>

<template>
  <div class="plan-editor col">
    <div class="spread">
      <span class="muted">版本 v{{ draft.version }}</span>
      <div class="row">
        <button v-if="aiEnabled" class="sm" @click="props.onAiSuggest('full')">AI Suggest 全计划</button>
        <button class="sm" @click="emit('paste')">Paste External AI</button>
        <button class="primary sm" @click="save">保存 DirectorPlan（新版本）</button>
      </div>
    </div>

    <div v-for="sec in sections" :key="sec.key" class="panel">
      <div class="panel-title spread">
        <span>{{ sec.title }}</span>
        <button v-if="sec.ai && aiEnabled" class="sm ghost" @click="props.onAiSuggest(sec.key)">AI Suggest</button>
      </div>
      <div class="panel-body grid two">
        <label v-for="f in sec.fields" :key="f.path.join('.')" class="field">
          {{ f.label }}
          <select v-if="f.type === 'select'" :value="fieldValue(f.path)" @change="setField(f.path, ($event.target as HTMLSelectElement).value)">
            <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
          </select>
          <textarea v-else-if="f.type === 'textarea'" :value="fieldValue(f.path)" rows="2" @input="setField(f.path, ($event.target as HTMLTextAreaElement).value)" />
          <input v-else-if="f.type === 'number'" type="number" :value="fieldValue(f.path)" @input="setField(f.path, Number(($event.target as HTMLInputElement).value))" />
          <template v-else-if="f.type === 'list'">
            <textarea :value="(fieldValue(f.path) as string[]).join('\n')" rows="2" @input="setField(f.path, ($event.target as HTMLTextAreaElement).value.split('\n').filter(Boolean))" />
          </template>
          <input v-else :value="fieldValue(f.path)" @input="setField(f.path, ($event.target as HTMLInputElement).value)" />
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.two { grid-template-columns: 1fr 1fr; }
@media (max-width: 900px) { .two { grid-template-columns: 1fr; } }
</style>
