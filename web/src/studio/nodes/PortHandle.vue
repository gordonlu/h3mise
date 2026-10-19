<script setup lang="ts">
import { computed } from 'vue';
import { Handle, Position, useNodeId } from '@vue-flow/core';
import type { CanvasPort } from '@h3mise/shared';
import { useStudioStore } from '../../stores/studio';
import { useToastStore } from '../../stores/toast';
import { t } from '../../stores/locale';

const props = defineProps<{ port: CanvasPort }>();
const store = useStudioStore();
const toasts = useToastStore();
const nodeId = useNodeId();
const keyboard = computed(() => store.keyboardConnect);
const isSource = computed(() =>
  keyboard.value?.sourceNodeId === nodeId && keyboard.value?.sourcePort === props.port.id,
);
const isTarget = computed(() =>
  keyboard.value?.targets.some((target) => target.nodeId === nodeId && target.port === props.port.id) ?? false,
);
const isDim = computed(() =>
  Boolean(keyboard.value) && props.port.direction === 'in' && props.port.visible && !isTarget.value,
);

function onKeydown(event: KeyboardEvent): void {
  if (props.port.direction !== 'out' || !props.port.userConnectable) return;
  if (event.key !== 'c' && event.key !== 'C') return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  event.preventDefault();
  event.stopPropagation();
  const started = store.startKeyboardConnect(nodeId, props.port.id);
  if (!started) toasts.push({ kind: 'info', text: t('studio.keyboard.noTargets') });
}
</script>

<template>
  <Handle
    :id="props.port.id"
    :type="props.port.direction === 'in' ? 'target' : 'source'"
    :position="props.port.direction === 'in' ? Position.Left : Position.Right"
    :connectable="props.port.userConnectable"
    :class="[
      `hf-h-${props.port.type}`,
      {
        'hf-kb-source': isSource,
        'hf-kb-target': isTarget,
        'hf-kb-dim': isDim,
      },
    ]"
    :aria-label="props.port.label"
    tabindex="0"
    @keydown="onKeydown"
  />
</template>
