<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useProjectStore } from '../stores/project';
import { useToastStore } from '../stores/toast';
import { confirmDialog } from '../stores/confirm';
import { post } from '../api/client';
import { t } from '../stores/locale';

const project = useProjectStore();
const router = useRouter();
const toasts = useToastStore();
const creating = ref(false);
const installingDemo = ref('');
const form = ref({ title: '', format: 'single_shot', defaultAspectRatio: '16:9', defaultDurationSeconds: 5 });
const error = ref('');

const FORMATS = [
  { value: 'single_shot', label: 'Single Shot', desc: () => t('workflow.projects.aSingleShotProjectWithoutAStory') },
  { value: 'sequence', label: 'Short Sequence', desc: () => t('workflow.projects.aShortSequenceWithMultipleShots') },
  { value: 'story', label: 'Story / Episode', desc: () => t('workflow.projects.aCompleteStoryOrEpisode') },
];

const DEMOS = [
  { id: 'last-film-reel', title: () => t('workflow.projects.theLastFilmReel'), desc: () => t('workflow.projects.aCompleteLongVideoExampleWithStory'), start: '/quick' },
  { id: 'good-boy', title: () => 'Good Boy', desc: () => t('workflow.projects.a30SecondSitcomExampleWithA'), start: '/story' },
];

function localizeAttention(title: string): string {
  const exact: Record<string, string> = {
    '进入成片编排': 'workflow.projects.attentionOpenTimeline',
    '导出成片': 'workflow.projects.attentionExport',
    '成片已导出': 'workflow.projects.attentionComplete',
  };
  return exact[title] ? t(exact[title]) : title;
}

async function createProject() {
  error.value = '';
  if (!form.value.title.trim()) {
    error.value = t('workflow.projects.enterAProjectName');
    return;
  }
  creating.value = true;
  try {
    const created = await project.createProject({ ...form.value, format: form.value.format as never });
    if (!created) return;
    toasts.push({ kind: 'ok', text: t('workflow.projects.projectValueCreated', { v0: form.value.title }) });
    router.push(form.value.format === 'story' ? '/story' : '/shots');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    creating.value = false;
  }
}

async function installDemo(demo: typeof DEMOS[number]) {
  installingDemo.value = demo.id;
  try {
    const installed = await project.installDemo(demo.id);
    if (!installed) return;
    toasts.push({ kind: 'ok', text: t('workflow.projects.demoValueInstalledAsAnEditableLocal', { v0: demo.title() }) });
    router.push(demo.start);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    installingDemo.value = '';
  }
}

async function openProject(id: string) {
  if (!(await project.openProject(id))) return;
  router.push(project.current?.meta.format === 'story' ? '/story' : '/shots');
}

async function continueProject(id: string, to = '/shots') {
  if (!(await project.openProject(id))) return;
  router.push(to);
}

async function quickEditProject(id: string) {
  if (!(await project.openProject(id))) return;
  router.push('/quick');
}

async function removeProject(id: string, title: string) {
  const ok = await confirmDialog({
    title: t('workflow.projects.deleteProjectValue', { v0: title }),
    message: t('workflow.projects.thisRemovesTheLocalProjectDirectoryIncluding'),
    confirmLabel: t('workflow.projects.deletePermanently'),
    danger: true,
  });
  if (!ok) return;
  await post(`/api/projects/${id}/delete`);
  toasts.push({ kind: 'ok', text: t('workflow.projects.projectValueDeleted', { v0: title }) });
  await project.refreshProjects();
}

onMounted(() => project.refreshProjects());
</script>

<template>
  <div class="page">
    <h1>{{ t('workflow.projects.projects') }}</h1>
    <p class="muted">{{ t('workflow.projects.h3miseIsALocalDirectorWorkstationProjects') }}</p>

    <div class="grid create">
      <div class="panel">
        <div class="panel-title">{{ t('workflow.projects.newProject') }}</div>
        <div class="panel-body col">
          <label class="field">
            {{ t('workflow.projects.projectName') }}
            <input v-model="form.title" :placeholder="t('workflow.projects.eGRainyNightAlley')" @keyup.enter="createProject" />
          </label>
          <label class="field">{{ t('workflow.projects.projectType') }}</label>
          <div class="col">
            <label v-for="f in FORMATS" :key="f.value" class="format-opt" :class="{ on: form.format === f.value }">
              <input v-model="form.format" type="radio" :value="f.value" />
              <span class="format-label">{{ f.label }}</span>
              <span class="muted">{{ f.desc() }}</span>
            </label>
          </div>
          <div class="row">
            <label class="field grow">
              {{ t('workflow.projects.aspectRatio') }}
              <select v-model="form.defaultAspectRatio">
                <option>16:9</option>
                <option>9:16</option>
                <option>4:3</option>
                <option>1:1</option>
              </select>
            </label>
            <label class="field grow">
              {{ t('workflow.projects.defaultShotDurationS') }}
              <input v-model.number="form.defaultDurationSeconds" type="number" min="1" max="15" :title="t('workflow.projects.defaultDurationForEachNewShotIncluding')" placeholder="5" />
            </label>
          </div>
          <p v-if="error" class="badge bad">{{ error }}</p>
          <button class="primary" :disabled="creating" @click="createProject">{{ creating ? t('workflow.projects.creating') : t('workflow.projects.createProject') }}</button>
          <div class="demo-entry">
            <div>
              <strong>{{ t('workflow.projects.firstTimeHere') }}</strong>
              <div class="muted">{{ t('workflow.projects.installACompleteExampleYouCanFreely') }}</div>
            </div>
            <div v-for="demo in DEMOS" :key="demo.id" class="demo-option">
              <div><strong>{{ demo.title() }}</strong><span class="muted">{{ demo.desc() }}</span></div>
              <button :disabled="Boolean(installingDemo)" @click="installDemo(demo)">{{ installingDemo === demo.id ? t('workflow.projects.installing') : t('workflow.projects.installDemo') }}</button>
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">{{ t('workflow.projects.existingProjects') }}</div>
        <div class="panel-body col">
          <div v-if="!project.projects.length" class="muted">{{ t('workflow.projects.noProjectsYetCreateOneToBegin') }}</div>
          <div v-for="p in project.projects" :key="p.id" class="proj-row">
            <div class="grow" @dblclick="openProject(p.id)">
              <div class="row">
                <span class="proj-title">{{ p.title }}</span>
                <span class="badge">{{ p.format }}</span>
              </div>
              <div class="muted mono">{{ p.dirPath }}</div>
              <div class="project-progress" role="progressbar" :aria-valuenow="p.guide?.selectedTakeCount ?? 0" :aria-valuemax="p.guide?.shotCount ?? 0">
                <span :style="{ width: `${p.guide?.shotCount ? (p.guide.selectedTakeCount / p.guide.shotCount) * 100 : 0}%` }" />
              </div>
              <div class="muted">{{ p.guide?.selectedTakeCount ?? p.selectedTakeCount ?? 0 }} / {{ p.guide?.shotCount ?? p.shotCount ?? 0 }} Shots {{ t('workflow.projects.selected') }} · {{ new Date(p.updatedAt).toLocaleString() }}</div>
              <div v-if="p.guide" class="resume-copy">
                <span class="resume-label">{{ p.guide.attention.kind === 'complete' ? t('workflow.projects.projectStatus') : t('workflow.projects.nextAction') }}</span>
                <span>{{ localizeAttention(p.guide.attention.title) }}</span>
              </div>
            </div>
            <button class="sm" @click="quickEditProject(p.id)">{{ t('workflow.projects.quickEdit') }}</button>
            <button class="primary sm" @click="continueProject(p.id, p.guide?.attention.to)">{{ t('workflow.projects.continue') }}</button>
            <button class="danger sm" :title="t('workflow.projects.deleteProject')" @click="removeProject(p.id, p.title)">{{ t('workflow.projects.delete') }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 28px 32px; max-width: 1100px; margin: 0 auto; }
h1 { font-size: 24px; margin: 0 0 4px; font-family: var(--serif); }
.grid.create { grid-template-columns: 1fr 1.3fr; align-items: start; margin-top: 20px; }
.format-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.format-opt.on { border-color: var(--accent); background: var(--accent-soft); }
.format-label { font-weight: 600; font-size: 13px; }
.demo-entry { display: grid; gap: 10px; margin-top: 4px; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg-muted); }
.demo-entry strong { display: block; margin-bottom: 3px; font-size: 13px; }
.demo-option { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 9px; border-top: 1px dashed var(--line); }
.demo-option > div { min-width: 0; }
.demo-option span { display: block; line-height: 1.45; }
.demo-option button { flex: none; }
.proj-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.proj-row:hover { border-color: var(--line-2); }
.proj-title { font-weight: 600; font-size: 14.5px; }
.project-progress { height: 5px; margin: 8px 0 5px; overflow: hidden; border-radius: 999px; background: var(--bg-muted); }
.project-progress span { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width 0.2s ease; }
.resume-copy { display: flex; gap: 7px; align-items: center; margin-top: 5px; color: var(--text-2); font-size: 12px; }
.resume-label { color: var(--accent-text); font-weight: 700; }
</style>
