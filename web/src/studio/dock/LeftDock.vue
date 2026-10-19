<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { t } from '../../stores/locale';
import { useStudioUiStore } from '../../stores/studioUi';
import NodeLibrary from './NodeLibrary.vue';
import AssetDock from './AssetDock.vue';
import OutlineTree from './OutlineTree.vue';

const ui = useStudioUiStore();
const { leftTab: tab } = storeToRefs(ui);
</script>

<template>
  <aside class="hf-left-dock" aria-label="Studio dock">
    <div class="hf-dock-tabs">
      <button class="hf-tab" :class="{ active: tab === 'nodes' }" @click="tab = 'nodes'">{{ t('studio.dock.nodes') }}</button>
      <button class="hf-tab" :class="{ active: tab === 'assets' }" @click="tab = 'assets'">{{ t('studio.dock.assets') }}</button>
      <button class="hf-tab" :class="{ active: tab === 'outline' }" @click="tab = 'outline'">{{ t('studio.dock.outline') }}</button>
    </div>
    <div class="hf-dock-body">
      <NodeLibrary v-if="tab === 'nodes'" />
      <AssetDock v-else-if="tab === 'assets'" />
      <OutlineTree v-else />
    </div>
  </aside>
</template>
