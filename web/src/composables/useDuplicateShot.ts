// Duplicate a Shot's design without copying Takes. The new Shot keeps the
// plan, latest prompt text, cast/scene fields and non-derived reference
// bindings; frame dependency, Takes, preflight and continuity start fresh.

import type { DirectorPlanVersion, PromptVersion, ReferenceBinding, Shot } from '@h3mise/shared';
import { get, post } from '../api/client';
import { useStudioStore } from '../stores/studio';
import { useToastStore } from '../stores/toast';
import { t } from '../stores/locale';

interface ShotDetail {
  shot: Shot;
  plans: DirectorPlanVersion[];
  prompts: PromptVersion[];
  bindings: ReferenceBinding[];
}

export function useDuplicateShot() {
  const store = useStudioStore();
  const toasts = useToastStore();

  async function duplicate(shotId: string, position: { x: number; y: number }): Promise<string | null> {
    const storyId = store.graph?.storyId;
    if (!storyId) return null;
    const detail = await get<ShotDetail>(`/api/shots/${encodeURIComponent(shotId)}`);
    const source = detail.shot;
    const created = await post<Shot>('/api/shots', {
      title: `${source.title} · ${t('studio.copy.suffix')}`,
      sequenceId: source.sequenceId,
      storyBeatId: source.storyBeatId,
      purpose: source.purpose,
      shotFunction: source.shotFunction,
      durationSeconds: source.durationSeconds,
      aspectRatio: source.aspectRatio,
      h3Mode: source.h3Mode,
      primaryCharacterId: source.primaryCharacterId,
      sceneId: source.sceneId,
      renderDependencyMode: 'auto',
      screenDirection: source.screenDirection,
      intentionalReversal: source.intentionalReversal,
    });

    const latestPlan = detail.plans.at(-1);
    if (latestPlan) {
      await post(`/api/shots/${encodeURIComponent(created.id)}/plans`, { plan: latestPlan.plan, source: 'manual' });
    }
    const latestPrompt = detail.prompts.at(-1);
    if (latestPrompt) {
      await post(`/api/shots/${encodeURIComponent(created.id)}/prompts/raw`, {
        text: latestPrompt.text,
        mode: latestPrompt.h3Mode,
        source: 'manual',
      });
    }
    for (const binding of detail.bindings) {
      if (binding.sourceEntityId) continue;
      await post('/api/assets/bindings', {
        assetId: binding.assetId,
        roles: binding.roles,
        preserve: binding.preserve,
        ignore: binding.ignore,
        label: binding.label,
        shotId: created.id,
      });
    }

    const shots = await get<Shot[]>('/api/shots');
    const ids = shots.map((shot) => shot.id).filter((id) => id !== created.id);
    const index = ids.indexOf(shotId);
    ids.splice(index >= 0 ? index + 1 : ids.length, 0, created.id);
    await post('/api/shots/reorder', { ids });

    await store.saveLayout({
      storyId,
      nodes: [{
        nodeId: `shot:${created.id}`,
        x: position.x + 40,
        y: position.y + 40,
        collapsed: false,
        pinned: true,
        userPlaced: false,
      }],
    });
    await store.refreshGraph();
    store.select(`shot:${created.id}`);
    store.focusNode(`shot:${created.id}`);
    toasts.push({ kind: 'ok', text: t('studio.copy.done') });
    return `shot:${created.id}`;
  }

  async function duplicateSelected(): Promise<void> {
    const selected = store.selection
      .map((id) => store.nodeById.get(id))
      .filter((node): node is NonNullable<typeof node> => node?.kind === 'shot');
    for (const node of selected) {
      const position = store.positions.get(node.id) ?? { x: 0, y: 0 };
      try {
        await duplicate(node.domainId, position);
      } catch (e) {
        toasts.push({ kind: 'err', text: t('studio.copy.failed', { msg: e instanceof Error ? e.message : String(e) }) });
      }
    }
  }

  return { duplicate, duplicateSelected };
}
