// Global project store: registry list, current project, provider/AI status.

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { ApiError, get, post, patch } from '../api/client';
import type { ProjectConfig, ProjectMeta, ProviderStatus } from '@h3mise/shared';
import { confirmDialog } from './confirm';

interface ProjectLockedResponse {
  code?: string;
  currentProject?: { id: string; title: string } | null;
}

export const useProjectStore = defineStore('project', () => {
  const projects = ref<ProjectMeta[]>([]);
  const current = ref<{ meta: ProjectMeta; config: ProjectConfig } | null>(null);
  const providers = ref<ProviderStatus[]>([]);
  const loaded = ref(false);

  const projectId = computed(() => current.value?.meta.id ?? null);

  async function refreshProjects() {
    projects.value = await get<ProjectMeta[]>('/api/projects');
    loaded.value = true;
  }

  async function refreshCurrent() {
    current.value = await get<{ meta: ProjectMeta; config: ProjectConfig } | null>('/api/current-project');
  }

  async function refreshProviders() {
    try {
      providers.value = await get<ProviderStatus[]>('/api/providers');
    } catch {
      providers.value = [];
    }
  }

  function lockInfo(error: unknown): ProjectLockedResponse | null {
    if (!(error instanceof ApiError) || error.status !== 409) return null;
    const body = error.body as ProjectLockedResponse | undefined;
    return body?.code === 'PROJECT_LOCKED' ? body : null;
  }

  async function confirmProjectSwitch(error: unknown, requestedTitle: string): Promise<boolean> {
    const info = lockInfo(error);
    if (!info) throw error;
    const currentTitle = info.currentProject?.title ?? '当前项目';
    return confirmDialog({
      title: '当前项目还在进行',
      message: `「${currentTitle}」正在使用中。切换到「${requestedTitle}」会让其他已打开的标签页也切换项目。`,
      confirmLabel: '切换当前项目',
    });
  }

  async function createProject(input: { title: string; format: string; defaultAspectRatio?: string; defaultDurationSeconds?: number; visualStyle?: string }): Promise<ProjectMeta | null> {
    let meta: ProjectMeta;
    try {
      meta = await post<ProjectMeta>('/api/projects', input);
    } catch (error) {
      if (!(await confirmProjectSwitch(error, input.title))) return null;
      meta = await post<ProjectMeta>('/api/projects', { ...input, force: true });
    }
    await refreshProjects();
    await refreshCurrent();
    await refreshProviders();
    return meta;
  }

  async function installDemo(): Promise<ProjectMeta | null> {
    const title = '最后一卷胶片（Demo）';
    let meta: ProjectMeta;
    try {
      meta = await post<ProjectMeta>('/api/projects/demo', {});
    } catch (error) {
      if (!(await confirmProjectSwitch(error, title))) return null;
      meta = await post<ProjectMeta>('/api/projects/demo', { force: true });
    }
    await refreshProjects();
    await refreshCurrent();
    await refreshProviders();
    return meta;
  }

  async function openProject(id: string): Promise<boolean> {
    const requestedTitle = projects.value.find((p) => p.id === id)?.title ?? id;
    try {
      await post(`/api/projects/${id}/open`, {});
    } catch (error) {
      if (!(await confirmProjectSwitch(error, requestedTitle))) return false;
      await post(`/api/projects/${id}/open`, { force: true });
    }
    await refreshCurrent();
    await refreshProviders();
    return true;
  }

  async function saveConfig(patchData: Partial<ProjectConfig>) {
    if (!current.value) return;
    const res = await patch<{ config: ProjectConfig }>('/api/current-project/config', patchData);
    current.value = { ...current.value, config: res.config };
  }

  async function bootstrap() {
    await refreshProjects();
    await refreshCurrent();
    await refreshProviders();
  }

  return { projects, current, providers, loaded, projectId, refreshProjects, refreshCurrent, refreshProviders, createProject, installDemo, openProject, saveConfig, bootstrap };
});
