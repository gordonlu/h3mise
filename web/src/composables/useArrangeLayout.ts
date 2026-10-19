// One-click deterministic lane arrangement. Layout is local-only, so clearing
// pinned positions never touches story/shot/take data.

import { useStudioStore } from '../stores/studio';
import { useToastStore } from '../stores/toast';
import { confirmDialog } from '../stores/confirm';
import { t } from '../stores/locale';

export function useArrangeLayout() {
  const store = useStudioStore();
  const toasts = useToastStore();

  async function arrange(): Promise<void> {
    const ok = await confirmDialog({
      title: t('studio.view.resetTitle'),
      message: t('studio.view.resetMessage'),
      confirmLabel: t('studio.view.resetConfirm'),
    });
    if (!ok) return;
    await store.resetLayout();
    store.fitAll();
    toasts.push({ kind: 'ok', text: t('studio.view.arranged') });
  }

  return { arrange };
}
