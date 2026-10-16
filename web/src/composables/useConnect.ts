// Drag-to-connect handling: validates with the shared rule table, collects a
// role set when needed, and resolves the 409 branches (replace / mode switch)
// before asking the store to run the command.

import { H3_MODE_LABEL, canConnect, type CanvasConnectRequest, type CanvasPortId, type H3Mode } from '@h3mise/shared';
import { ApiError } from '../api/client';
import { useStudioStore } from '../stores/studio';
import { useToastStore } from '../stores/toast';
import { useRolePickerStore } from '../stores/rolePicker';
import { confirmDialog } from '../stores/confirm';
import { t } from '../stores/locale';

const ERROR_TEXT: Record<string, string> = {
  cycle: 'studio.connect.cycle',
  locked: 'studio.connect.locked',
  reference_limit: 'studio.connect.referenceLimit',
  invalid_connection: 'studio.connect.invalid',
};

export function useConnect() {
  const store = useStudioStore();
  const toasts = useToastStore();
  const rolePicker = useRolePickerStore();

  function isValid(sourceId: string, sourceHandle: string | null | undefined, targetId: string, targetHandle: string | null | undefined): boolean {
    if (!sourceHandle || !targetHandle) return false;
    const source = store.nodeById.get(sourceId);
    const target = store.nodeById.get(targetId);
    if (!source || !target) return false;
    return canConnect(source, sourceHandle as CanvasPortId, target, targetHandle as CanvasPortId).ok;
  }

  async function attempt(base: CanvasConnectRequest, options: CanvasConnectRequest['options']): Promise<void> {
    try {
      const result = await store.connect({ ...base, options });
      toasts.push({
        kind: 'ok',
        text: t('studio.connect.connected'),
        actionLabel: t('studio.undo'),
        action: () => {
          const undo = result.undo;
          if (!undo) return;
          if (undo.method === 'POST') void store.connect(undo.request);
          else void store.disconnect(undo.edgeId);
        },
        timeout: 6000,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        const body = error.body as { code?: string; existing?: { label?: string }; suggestedMode?: H3Mode } | null;
        if (body?.code === 'needs_replace') {
          const ok = await confirmDialog({
            title: t('studio.confirm.replaceTitle'),
            message: t('studio.confirm.replaceMessage', { existing: body.existing?.label ?? '' }),
            confirmLabel: t('common.confirm'),
          });
          if (ok) return attempt(base, { ...options, replace: true });
          return;
        }
        if (body?.code === 'needs_mode_switch' && body.suggestedMode) {
          const ok = await confirmDialog({
            title: t('studio.confirm.modeTitle'),
            message: t('studio.confirm.modeMessage', { mode: H3_MODE_LABEL[body.suggestedMode] }),
            confirmLabel: t('common.confirm'),
          });
          if (ok) return attempt(base, { ...options, switchMode: body.suggestedMode });
          return;
        }
        const key = body?.code ? ERROR_TEXT[body.code] : undefined;
        toasts.push({ kind: 'err', text: key ? t(key) : t('studio.connect.failed', { msg: error.message }) });
        return;
      }
      toasts.push({ kind: 'err', text: t('studio.connect.failed', { msg: error instanceof Error ? error.message : String(error) }) });
    }
  }

  async function connect(sourceId: string, sourceHandle: string | null | undefined, targetId: string, targetHandle: string | null | undefined): Promise<void> {
    if (!sourceHandle || !targetHandle) return;
    const source = store.nodeById.get(sourceId);
    const target = store.nodeById.get(targetId);
    const storyId = store.graph?.storyId;
    if (!source || !target || !storyId) return;
    const verdict = canConnect(source, sourceHandle as CanvasPortId, target, targetHandle as CanvasPortId);
    if (!verdict.ok) {
      toasts.push({ kind: 'err', text: verdict.reason });
      return;
    }
    const base: CanvasConnectRequest = {
      storyId,
      source: { nodeId: sourceId, port: sourceHandle as CanvasPortId },
      target: { nodeId: targetId, port: targetHandle as CanvasPortId },
    };
    const options: CanvasConnectRequest['options'] = {};
    if (verdict.rule.needsRolePicker) {
      const roles = await rolePicker.ask(['style']);
      if (!roles) return;
      options.roles = roles;
    }
    await attempt(base, options);
  }

  async function disconnect(edgeId: string): Promise<void> {
    const ok = await confirmDialog({
      title: t('studio.disconnect.confirm'),
      message: t('studio.disconnect.confirmMessage'),
      confirmLabel: t('common.remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await store.disconnect(edgeId);
      toasts.push({
        kind: 'ok',
        text: t('studio.disconnect.done'),
        actionLabel: t('studio.undo'),
        action: () => {
          if (result.undo && result.undo.method === 'POST') void store.connect(result.undo.request);
        },
        timeout: 6000,
      });
    } catch (error) {
      toasts.push({ kind: 'err', text: t('studio.disconnect.failed', { msg: error instanceof Error ? error.message : String(error) }) });
    }
  }

  return { isValid, connect, disconnect };
}
