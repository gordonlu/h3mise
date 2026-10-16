<script setup lang="ts">
import { computed } from 'vue';
import type { CanvasConnectRequest, CanvasPortId } from '@h3mise/shared';
import { useQuickCreateStore } from '../../stores/quickCreate';
import { useStudioStore } from '../../stores/studio';
import { useCanvasCreate } from '../../composables/useCanvasCreate';
import { t } from '../../stores/locale';

const quick = useQuickCreateStore();
const studio = useStudioStore();
const { create } = useCanvasCreate();

interface Option {
  label: string;
  mode: 't2va' | 'i2va';
  sourcePort: CanvasPortId;
  targetPort: CanvasPortId;
}

const options = computed<Option[]>(() => {
  const source = quick.pending?.source;
  if (!source) return [];
  if (source.nodeId.startsWith('beat:') && source.port === 'beat') {
    return [{ label: t('studio.quick.shotFromBeat'), mode: 't2va', sourcePort: 'beat', targetPort: 'beat' }];
  }
  if (source.nodeId.startsWith('shot:') && source.port === 'tail_frame') {
    return [{ label: t('studio.quick.nextShotChain'), mode: 'i2va', sourcePort: 'tail_frame', targetPort: 'first_frame' }];
  }
  return [];
});

async function choose(option: Option): Promise<void> {
  const pend = quick.pending;
  const storyId = studio.graph?.storyId;
  if (!pend || !storyId) return;
  const created = await create({ kind: 'shot', mode: option.mode }, pend.graph);
  quick.close();
  if (!created) return;
  const request: CanvasConnectRequest = {
    storyId,
    source: { nodeId: pend.source.nodeId, port: option.sourcePort },
    target: { nodeId: created, port: option.targetPort },
  };
  try {
    await studio.connect(request);
  } catch {
    /* the node exists even if the auto-connect has a conflict; the user can wire it */
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="quick.pending" class="hf-ctx-backdrop" @click="quick.close()" @contextmenu.prevent="quick.close()">
      <div class="hf-ctx" :style="{ left: `${quick.pending.screen.x}px`, top: `${quick.pending.screen.y}px` }" @click.stop>
        <button v-for="option in options" :key="option.label" class="hf-ctx-item" @click="choose(option)">{{ option.label }}</button>
        <div v-if="options.length === 0" class="hf-ctx-item muted">{{ t('studio.quick.none') }}</div>
      </div>
    </div>
  </Teleport>
</template>
