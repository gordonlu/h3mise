<script setup lang="ts">
import { useStudioStore } from '../../stores/studio';
import { t } from '../../stores/locale';

const store = useStudioStore();
</script>

<template>
  <div class="hf-inspector-empty">
    <p class="hf-inspector-empty-title">{{ t('studio.inspector.multi', { n: store.selection.length }) }}</p>
    <p class="hf-muted">{{ t('studio.inspector.multiHint') }}</p>
  </div>
</template>
