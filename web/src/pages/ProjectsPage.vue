<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useProjectStore } from '../stores/project';
import { useToastStore } from '../stores/toast';
import { confirmDialog } from '../stores/confirm';
import { post } from '../api/client';

const project = useProjectStore();
const router = useRouter();
const toasts = useToastStore();
const creating = ref(false);
const form = ref({ title: '', format: 'single_shot', defaultAspectRatio: '16:9', defaultDurationSeconds: 5 });
const error = ref('');

const FORMATS = [
  { value: 'single_shot', label: 'Single Shot', desc: '单镜头项目，不需要 Story' },
  { value: 'sequence', label: 'Short Sequence', desc: '短片序列，可拆多个 Shot' },
  { value: 'story', label: 'Story / Episode', desc: '完整故事 / 剧集' },
];

async function createProject() {
  error.value = '';
  if (!form.value.title.trim()) {
    error.value = '请输入项目名称';
    return;
  }
  creating.value = true;
  try {
    await project.createProject({ ...form.value, format: form.value.format as never });
    toasts.push({ kind: 'ok', text: `项目「${form.value.title}」已创建` });
    router.push('/shots');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    creating.value = false;
  }
}

async function openProject(id: string) {
  await project.openProject(id);
  router.push('/shots');
}

async function removeProject(id: string, title: string) {
  const ok = await confirmDialog({
    title: `删除项目「${title}」？`,
    message: '将移除本地项目目录（含媒体资产、全部 Take、Prompt 与连续性记录）。此操作不可恢复。',
    confirmLabel: '永久删除',
    danger: true,
  });
  if (!ok) return;
  await post(`/api/projects/${id}/delete`);
  toasts.push({ kind: 'ok', text: `项目「${title}」已删除` });
  await project.refreshProjects();
}

onMounted(() => project.refreshProjects());
</script>

<template>
  <div class="page">
    <h1>项目</h1>
    <p class="muted">H3Mise 是本地导演工作台 — 项目、资产、Prompt、Take、连续性全部保存在本地。RunningHub 仅作为渲染后端。</p>

    <div class="grid create">
      <div class="panel">
        <div class="panel-title">新建项目</div>
        <div class="panel-body col">
          <label class="field">
            项目名称
            <input v-model="form.title" placeholder="例如：雨夜小巷" @keyup.enter="createProject" />
          </label>
          <label class="field">项目类型</label>
          <div class="col">
            <label v-for="f in FORMATS" :key="f.value" class="format-opt" :class="{ on: form.format === f.value }">
              <input v-model="form.format" type="radio" :value="f.value" />
              <span class="format-label">{{ f.label }}</span>
              <span class="muted">{{ f.desc }}</span>
            </label>
          </div>
          <div class="row">
            <label class="field grow">
              画幅
              <select v-model="form.defaultAspectRatio">
                <option>16:9</option>
                <option>9:16</option>
                <option>4:3</option>
                <option>1:1</option>
              </select>
            </label>
            <label class="field grow">
              默认时长 (s)
              <input v-model.number="form.defaultDurationSeconds" type="number" min="1" max="15" title="每个新镜头的默认时长（1–15 秒）" placeholder="5" />
            </label>
          </div>
          <p v-if="error" class="badge bad">{{ error }}</p>
          <button class="primary" :disabled="creating" @click="createProject">创建项目</button>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">已有项目</div>
        <div class="panel-body col">
          <div v-if="!project.projects.length" class="muted">还没有项目。新建一个开始。</div>
          <div v-for="p in project.projects" :key="p.id" class="proj-row">
            <div class="grow" @dblclick="openProject(p.id)">
              <div class="row">
                <span class="proj-title">{{ p.title }}</span>
                <span class="badge">{{ p.format }}</span>
              </div>
              <div class="muted mono">{{ p.dirPath }}</div>
              <div class="muted">
                {{ p.shotCount ?? 0 }} Shots · {{ p.selectedTakeCount ?? 0 }} Selected Takes ·
                {{ new Date(p.updatedAt).toLocaleString() }}
              </div>
            </div>
            <button class="primary sm" @click="openProject(p.id)">打开</button>
            <button class="danger sm" title="删除项目" @click="removeProject(p.id, p.title)">删除</button>
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
</style>
