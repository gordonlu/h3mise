<script setup lang="ts">
import { t } from '../../stores/locale';

const links = [
  { to: '/story', key: 'nav.story' },
  { to: '/shots', key: 'nav.shots' },
  { to: '/assets', key: 'nav.assets' },
  { to: '/timeline', key: 'nav.timeline' },
];
</script>

<template>
  <div class="hf-inspector-empty">
    <p class="hf-inspector-empty-title">{{ t('studio.inspector.empty') }}</p>
    <p class="hf-muted">{{ t('studio.inspector.emptyHint') }}</p>
    <div class="hf-quick-links">
      <RouterLink v-for="link in links" :key="link.to" :to="link.to" class="hf-ghost">
        {{ t(link.key) }}
      </RouterLink>
    </div>
  </div>
</template>
