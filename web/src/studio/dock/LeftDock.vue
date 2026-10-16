<script setup lang="ts">
import { ref } from 'vue';
import { t } from '../../stores/locale';
import NodeLibrary from './NodeLibrary.vue';
import AssetDock from './AssetDock.vue';

type Tab = 'nodes' | 'assets';
const tab = ref<Tab>('nodes');
</script>

<template>
  <aside class="hf-left-dock" aria-label="Studio dock">
    <div class="hf-dock-tabs">
      <button class="hf-tab" :class="{ active: tab === 'nodes' }" @click="tab = 'nodes'">{{ t('studio.dock.nodes') }}</button>
      <button class="hf-tab" :class="{ active: tab === 'assets' }" @click="tab = 'assets'">{{ t('studio.dock.assets') }}</button>
    </div>
    <div class="hf-dock-body">
      <NodeLibrary v-if="tab === 'nodes'" />
      <AssetDock v-else />
    </div>
  </aside>
</template>
