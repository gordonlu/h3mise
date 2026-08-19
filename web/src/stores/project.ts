// Global project store: registry list, current project, provider/AI status.

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { get, post, patch } from '../api/client';
import type { ProjectConfig, ProjectMeta, ProviderStatus } from '@h3mise/shared';

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

  async function createProject(input: { title: string; format: string; defaultAspectRatio?: string; defaultDurationSeconds?: number; visualStyle?: string }) {
    const meta = await post<ProjectMeta>('/api/projects', input);
    await openProject(meta.id);
    return meta;
  }

  async function openProject(id: string) {
    await post(`/api/projects/${id}/open`);
    await refreshCurrent();
    await refreshProviders();
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

  return { projects, current, providers, loaded, projectId, refreshProjects, refreshCurrent, refreshProviders, createProject, openProject, saveConfig, bootstrap };
});
