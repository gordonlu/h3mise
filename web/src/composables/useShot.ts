// Shot detail composable: loads the full shot payload and exposes actions
// (plan save, compile, preflight, render, take ops). Shared by Director Desk.

import { ref, computed } from 'vue';
import { get, post, patch, del } from '../api/client';
import type {
  DirectorPlan,
  DirectorPlanVersion,
  PreflightReport,
  PromptVersion,
  ReferenceBinding,
  RenderJob,
  Shot,
  Take,
  VisualContinuityState,
  ShotGuideState,
  NextAction,
  ContinuityEntry,
} from '@h3mise/shared';

export interface ShotDetail {
  shot: Shot;
  plans: DirectorPlanVersion[];
  prompts: PromptVersion[];
  takes: Take[];
  jobs: RenderJob[];
  preflights: PreflightReport[];
  bindings: ReferenceBinding[];
  requirements: Array<{ level: string; kind: string; label: string; detail: string }>;
  continuity: ContinuityEntry[];
  allBindings: ReferenceBinding[];
  entities: Array<{ id: string; name: string; kind: string; imageAssetId: string | null }>;
  characterStates: Array<{ id: string; characterId: string; name: string; costume: string; imageAssetId: string | null; effectiveImageAssetId: string | null }>;
  sequences: Array<{ id: string; title: string }>;
  beats: Array<{ id: string; title: string }>;
  continuityLatest: {
    visualActual: { state: VisualContinuityState | null } | null;
    visualPlanned: { state: VisualContinuityState | null } | null;
    narrative: unknown;
  } | null;
  guide: { state: ShotGuideState; nextAction: NextAction };
}

export function useShot(shotId: string) {
  const detail = ref<ShotDetail | null>(null);
  const loading = ref(false);
  const error = ref('');

  const shot = computed(() => detail.value?.shot ?? null);
  const latestPlan = computed(() => detail.value?.plans.at(-1) ?? null);
  const latestPrompt = computed(() => detail.value?.prompts.at(-1) ?? null);
  const selectedTake = computed(() => detail.value?.takes.find((t) => t.status === 'selected') ?? null);

  async function load() {
    loading.value = true;
    error.value = '';
    try {
      detail.value = await get<ShotDetail>(`/api/shots/${shotId}`);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  async function savePlan(plan: DirectorPlan, source: 'manual' | 'external_ai' | 'builtin_ai' = 'manual') {
    await post(`/api/shots/${shotId}/plans`, { plan, source });
    await load();
  }

  async function compilePrompt(mode: string) {
    const pv = await post<PromptVersion>(`/api/shots/${shotId}/prompts/compile`, { mode });
    await load();
    return pv;
  }

  async function importRawPrompt(text: string, mode: string, source: 'manual' | 'ai_compiler' = 'manual') {
    const pv = await post<PromptVersion>(`/api/shots/${shotId}/prompts/raw`, { text, mode, source });
    await load();
    return pv;
  }

  async function runPreflight(promptVersionId: string, providerId = 'runninghub', megapixels?: number): Promise<PreflightReport> {
    const report = await post<PreflightReport>(`/api/shots/${shotId}/preflight`, { promptVersionId, providerId, megapixels });
    await load();
    return report;
  }

  async function attachSemanticReview(reportId: string, text: string): Promise<PreflightReport> {
    const report = await patch<PreflightReport>(`/api/preflight/${reportId}/semantic`, { text });
    await load();
    return report;
  }

  async function render(promptVersionId: string, providerId = 'runninghub', durationSeconds?: number, megapixels?: number): Promise<RenderJob> {
    try {
      const job = await post<RenderJob>('/api/render', { shotId, promptVersionId, providerId, durationSeconds, megapixels });
      await load();
      return job;
    } catch (error) {
      // A paid submission always reruns preflight. Refresh the detail payload
      // so a newly-created blocking report is visible instead of only showing
      // a transient API error toast.
      await load().catch(() => undefined);
      throw error;
    }
  }

  async function selectTake(takeId: string) {
    await post(`/api/takes/${takeId}/select`);
    await load();
  }

  async function rejectTake(takeId: string) {
    await post(`/api/takes/${takeId}/reject`);
    await load();
  }

  async function deleteTake(takeId: string) {
    await del(`/api/takes/${takeId}`);
    await load();
  }

  async function updateTake(takeId: string, patchData: Partial<Pick<Take, 'rating' | 'failureTags' | 'notes' | 'status'>>) {
    await patch(`/api/takes/${takeId}`, patchData);
    await load();
  }

  async function selectAndCommit(takeId: string, state: VisualContinuityState) {
    await post(`/api/takes/${takeId}/select-commit`, { state });
    await load();
  }

  async function commitContinuity(input: { scope: 'visual' | 'narrative'; kind: 'planned' | 'actual'; state?: VisualContinuityState; sourceTakeId?: string | null }) {
    await post('/api/continuity/commit', { shotId, ...input });
    await load();
  }

  async function addBinding(input: { assetId: string; roles: string[]; label?: string }) {
    await post('/api/assets/bindings', { ...input, shotId });
    await load();
  }

  async function updateBinding(bindingId: string, patchData: Partial<ReferenceBinding>) {
    await patch(`/api/assets/bindings/${bindingId}`, patchData);
    await load();
  }

  async function removeBinding(bindingId: string) {
    await del(`/api/assets/bindings/${bindingId}`);
    await load();
  }

  async function updateShot(patchData: Partial<Shot>) {
    await patch(`/api/shots/${shotId}`, patchData);
    await load();
  }

  async function contextPackage(task: string) {
    return post<Record<string, unknown>>(`/api/shots/${shotId}/context-package`, { task });
  }

  return {
    detail,
    loading,
    error,
    shot,
    latestPlan,
    latestPrompt,
    selectedTake,
    load,
    savePlan,
    compilePrompt,
    importRawPrompt,
    runPreflight,
    attachSemanticReview,
    render,
    selectTake,
    rejectTake,
    deleteTake,
    updateTake,
    selectAndCommit,
    commitContinuity,
    addBinding,
    updateBinding,
    removeBinding,
    updateShot,
    contextPackage,
  };
}
