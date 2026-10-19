<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { CanvasBadge, CanvasNode, CanvasPort } from '@h3mise/shared';
import { t } from '../../stores/locale';
import type { StudioLod } from '../../stores/studio';
import PortHandle from './PortHandle.vue';
import NodeIcon from './NodeIcon.vue';
import { useStudioStore } from '../../stores/studio';

const studio = useStudioStore();
const root = ref<HTMLElement | null>(null);
let observer: ResizeObserver | null = null;

onMounted(() => {
  if (!root.value) return;
  observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (entry) studio.setMeasuredHeight(props.node.id, entry.contentRect.height);
  });
  observer.observe(root.value);
});
onUnmounted(() => observer?.disconnect());

const props = defineProps<{
  node: CanvasNode;
  selected: boolean;
  lod: StudioLod;
  dim?: boolean;
  icon?: string;
  status?: string;
  statusClass?: string;
}>();

const inPorts = computed(() => props.node.ports.filter((port) => port.direction === 'in' && port.visible));
const outPorts = computed(() => props.node.ports.filter((port) => port.direction === 'out' && port.visible));

function portLabel(port: CanvasPort): string {
  const key = `studio.port.${port.id}`;
  const translated = t(key);
  return translated === key ? port.label : translated;
}

function badgeText(badge: CanvasBadge): string {
  if (badge.kind === 'paid') return t('studio.badge.paid');
  const key = `studio.badge.${badge.kind}`;
  const translated = t(key);
  const base = translated === key ? badge.kind : translated;
  return badge.count ? `${base} ${badge.count}` : base;
}

const aria = computed(() => `${t(`studio.node.${props.node.kind}`)} ${props.node.title}${props.status ? ` · ${props.status}` : ''}`);
</script>

<template>
  <div
    ref="root"
    class="hf-node"
    :class="[`k-${props.node.kind}`, `lod-${props.lod}`, { 'is-selected': props.selected, 'is-dim': props.dim }]"
    role="group"
    :aria-label="aria"
    tabindex="0"
  >
    <span class="hf-bar" />
    <header class="hf-head">
      <span class="hf-icon" aria-hidden="true"><NodeIcon :name="props.icon" /></span>
      <span class="hf-title" :title="props.node.title">{{ props.node.title }}</span>
      <span class="hf-badges">
        <span
          v-for="badge in props.node.badges"
          :key="badge.kind"
          class="hf-badge"
          :class="`b-${badge.kind}`"
        >{{ badgeText(badge) }}</span>
      </span>
    </header>

    <div class="hf-main">
      <div class="hf-col hf-in">
        <div v-for="port in inPorts" :key="port.id" class="hf-port" :class="`p-${port.type}`">
          <PortHandle :port="port" />
          <span class="hf-port-label">{{ portLabel(port) }}</span>
        </div>
      </div>
      <div class="hf-body"><slot /></div>
      <div class="hf-col hf-out">
        <div v-for="port in outPorts" :key="port.id" class="hf-port hf-out" :class="`p-${port.type}`">
          <PortHandle :port="port" />
          <span class="hf-port-label">{{ portLabel(port) }}</span>
        </div>
      </div>
    </div>

    <footer v-if="props.status || $slots.foot" class="hf-foot">
      <span v-if="props.statusClass" class="hf-dot" :class="props.statusClass" />
      <span class="hf-status">{{ props.status }}</span>
      <slot name="foot" />
    </footer>
  </div>
</template>
