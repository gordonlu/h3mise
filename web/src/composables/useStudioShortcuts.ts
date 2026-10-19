// Studio keyboard shortcuts. Global-app shortcuts (⌘K) live in App.vue;
// these are canvas-first keys from the UI design (§10.1–10.2). Typing and
// open overlays always win, and Enter still goes through the normal paid
// confirmation path.

import { onMounted, onUnmounted } from 'vue';
import { useConfirmStore } from '../stores/confirm';
import { useNoteEditorStore } from '../stores/noteEditor';
import { usePaidActionStore } from '../stores/paidAction';
import { useQuickCreateStore } from '../stores/quickCreate';
import { useRolePickerStore } from '../stores/rolePicker';
import { useRunPlanStore } from '../stores/runPlan';

export interface StudioShortcutHandlers {
  toggleLeftDock: () => void;
  toggleInspector: () => void;
  toggleBottomDock: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fitAll: () => void;
  fitSelection: () => void;
  escape: () => void;
  runSelected: () => void;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('button, a, [role="button"]')) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
}

export function useStudioShortcuts(handlers: StudioShortcutHandlers) {
  const paid = usePaidActionStore();
  const quick = useQuickCreateStore();
  const runPlan = useRunPlanStore();
  const noteEditor = useNoteEditorStore();
  const rolePicker = useRolePickerStore();
  const confirm = useConfirmStore();

  function overlayOpen(): boolean {
    return Boolean(
      paid.pending ||
      quick.pending ||
      runPlan.contextMenu ||
      runPlan.plan ||
      runPlan.autoPlan ||
      noteEditor.pending ||
      rolePicker.pending ||
      confirm.pending,
    );
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === 'Escape') {
      // The command palette owns its own Escape handling.
      if (document.querySelector('.palette-backdrop')) return;
      handlers.escape();
      return;
    }
    if (isTyping(event.target) || overlayOpen()) return;

    switch (event.code) {
      case 'BracketLeft':
        event.preventDefault();
        handlers.toggleLeftDock();
        break;
      case 'BracketRight':
        event.preventDefault();
        handlers.toggleInspector();
        break;
      case 'Backquote':
        event.preventDefault();
        handlers.toggleBottomDock();
        break;
      case 'Equal':
        event.preventDefault();
        handlers.zoomIn();
        break;
      case 'Minus':
        event.preventDefault();
        handlers.zoomOut();
        break;
      case 'Digit1':
        if (event.shiftKey) {
          event.preventDefault();
          handlers.fitAll();
        }
        break;
      case 'Digit2':
        if (event.shiftKey) {
          event.preventDefault();
          handlers.fitSelection();
        }
        break;
      case 'Enter':
        event.preventDefault();
        handlers.runSelected();
        break;
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeydown));
  onUnmounted(() => window.removeEventListener('keydown', onKeydown));
}
