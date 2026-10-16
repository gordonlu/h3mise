// Drag-in creation from the Studio left dock. A dock item drops a descriptor;
// the canvas maps the drop point to graph coordinates and this composable
// creates the matching domain object and pins its layout position.

import type { EntityKind, H3Mode, Shot } from '@h3mise/shared';
import { post } from '../api/client';
import { useStudioStore } from '../stores/studio';
import { useToastStore } from '../stores/toast';
import { t } from '../stores/locale';

export interface CreateDescriptor {
  kind: 'shot' | 'beat' | 'entity' | 'note' | 'frame';
  mode?: H3Mode;
  entityKind?: EntityKind;
  label?: string;
}

export const CREATE_MIME = 'application/x-h3-create';

export function useCanvasCreate() {
  const store = useStudioStore();
  const toasts = useToastStore();

  /** Nearest Beat row to the drop point (within one row height). */
  function beatAt(y: number): string | null {
    let best: { id: string; distance: number } | null = null;
    for (const node of store.graph?.nodes ?? []) {
      if (node.kind !== 'beat') continue;
      const position = store.positions.get(node.id);
      if (!position) continue;
      const distance = Math.abs(position.y - y);
      if (distance <= 64 && (!best || distance < best.distance)) best = { id: node.domainId, distance };
    }
    return best?.id ?? null;
  }

  async function create(descriptor: CreateDescriptor, position: { x: number; y: number }): Promise<void> {
    const storyId = store.graph?.storyId;
    if (!storyId) return;
    if (descriptor.kind === 'shot') {
      const beatId = beatAt(position.y);
      const shot = await post<Shot>('/api/shots', {
        h3Mode: descriptor.mode ?? 't2va',
        renderDependencyMode: descriptor.mode === 'i2va' ? 'manual_frame' : 'auto',
        ...(beatId ? { storyBeatId: beatId } : {}),
      });
      await store.saveLayout({
        storyId,
        nodes: [{ nodeId: `shot:${shot.id}`, x: position.x, y: position.y, collapsed: false, pinned: true, userPlaced: false }],
      });
      await store.refreshGraph();
      store.select(`shot:${shot.id}`);
    } else if (descriptor.kind === 'beat') {
      await post('/api/story/beats', { title: descriptor.label ?? t('studio.create.newBeat') });
      await store.refreshGraph();
    } else if (descriptor.kind === 'entity') {
      const entity = await post<{ id: string }>('/api/assets/entities', {
        kind: descriptor.entityKind ?? 'character',
        name: descriptor.label ?? t('studio.create.newEntity'),
      });
      await store.refreshGraph();
      store.select(`entity:${entity.id}`);
    } else {
      await post('/api/canvas/annotations', { storyId, kind: descriptor.kind, x: position.x, y: position.y, text: '' });
      await store.load();
    }
    toasts.push({ kind: 'ok', text: t('studio.create.done') });
  }

  return { create, beatAt };
}
