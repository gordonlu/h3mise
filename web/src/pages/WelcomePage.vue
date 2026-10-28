<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { get } from '../api/client';
import { t } from '../stores/locale';

interface SetupHealth {
  runningHubConfigured: boolean;
  aiConfigured: boolean;
  ffmpeg: { available: boolean };
}
const health = ref<SetupHealth | null>(null);
const loading = ref(false);
const failed = ref(false);

async function refresh() {
  loading.value = true;
  failed.value = false;
  try { health.value = await get<SetupHealth>('/api/health'); }
  catch { health.value = null; failed.value = true; }
  finally { loading.value = false; }
}
onMounted(refresh);
</script>

<template>
  <div class="page welcome-page">
    <header>
      <span class="badge">{{ t('welcome.guide') }}</span>
      <h1>{{ t('welcome.title') }}</h1>
      <p class="muted">{{ t('welcome.subtitle') }}</p>
    </header>
    <p v-if="loading" role="status">{{ t('welcome.checking') }}</p>
    <div v-if="failed" class="row wrap" role="alert">
      <span>{{ t('welcome.checkFailed') }}</span>
      <button @click="refresh">{{ t('welcome.retry') }}</button>
    </div>

    <div class="welcome-options">
      <section class="panel">
        <div class="panel-body col">
          <h2>{{ t('welcome.freeTitle') }}</h2>
          <p>{{ t('welcome.freeHelp') }}</p>
          <RouterLink class="button-link primary" to="/projects">{{ t('welcome.freeAction') }}</RouterLink>
        </div>
      </section>
      <section class="panel">
        <div class="panel-body col">
          <h2>{{ t('welcome.realTitle') }}</h2>
          <span v-if="health" class="badge" :class="health.runningHubConfigured ? 'ok' : 'warn'">{{ t(health.runningHubConfigured ? 'welcome.keyReady' : 'welcome.keyMissing') }}</span>
          <p>{{ t('welcome.realHelp') }}</p>
          <RouterLink class="button-link" to="/settings#set-runninghub">{{ t('welcome.realAction') }}</RouterLink>
          <p class="muted">{{ t('welcome.keyNote') }}</p>
          <RouterLink to="/settings#set-comfyui">{{ t('welcome.comfy') }}</RouterLink>
        </div>
      </section>
    </div>

    <div class="panel">
      <div class="panel-body setup-details">
        <section class="col">
          <h2>{{ t('welcome.aiTitle') }}</h2>
          <span v-if="health" class="badge" :class="health.aiConfigured ? 'ok' : 'muted'">{{ t(health.aiConfigured ? 'welcome.aiReady' : 'welcome.aiMissing') }}</span>
          <p class="muted">{{ t('welcome.aiHelp') }}</p>
          <RouterLink to="/settings#set-ai">{{ t('welcome.aiAction') }}</RouterLink>
        </section>
        <section class="col">
          <h2>{{ t('welcome.toolsTitle') }}</h2>
          <span v-if="health" class="badge" :class="health.ffmpeg.available ? 'ok' : 'warn'">{{ t(health.ffmpeg.available ? 'welcome.toolsReady' : 'welcome.toolsMissing') }}</span>
          <template v-if="health && !health.ffmpeg.available">
            <p class="muted">{{ t('welcome.toolsHelp') }}</p>
            <a href="https://ffmpeg.org/download.html" target="_blank" rel="noreferrer">{{ t('welcome.toolsLink') }}</a>
          </template>
        </section>
      </div>
    </div>
    <footer class="col">
      <div class="row wrap">
        <button :disabled="loading" @click="refresh">{{ t('welcome.refresh') }}</button>
        <RouterLink to="/studio">{{ t('welcome.continue') }}</RouterLink>
      </div>
      <p class="muted">{{ t('welcome.windowNote') }}</p>
    </footer>
  </div>
</template>

<style scoped>
.welcome-page { display: flex; flex-direction: column; gap: 24px; }
.welcome-page h1 { margin: 12px 0; }
.welcome-page h2 { font-size: 18px; margin: 0; }
.welcome-page p { line-height: 1.8; margin: 0; }
.welcome-options, .setup-details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; }
.welcome-page .panel-body { padding: 24px; }
.welcome-page .col { align-items: flex-start; gap: 14px; }
.welcome-page .badge { white-space: normal; }
.welcome-page .button-link { display: inline-flex; padding: 10px 16px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg-2); color: var(--text); font-weight: 600; text-decoration: none; }
.welcome-page .button-link:hover { border-color: var(--accent); }
.welcome-page .button-link.primary { background: var(--accent); border-color: var(--accent); color: white; }
@media (max-width: 900px) {
  .welcome-options, .setup-details { grid-template-columns: minmax(0, 1fr); }
  .welcome-page .panel-body { padding: 18px; }
}
</style>
