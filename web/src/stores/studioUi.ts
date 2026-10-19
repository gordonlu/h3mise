// Studio shell UI state: dock visibility and active tabs. This is browser
// preference, not project data, so it stays out of the layout document and is
// persisted to localStorage. Deep links and the command palette write here.

import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

export type LeftDockTab = 'nodes' | 'assets' | 'outline';
export type BottomDockTab = 'timeline' | 'queue' | 'problems' | 'ai' | 'log';
export type StudioMegapixels = 0.6 | 0.8 | 1 | 1.2;

export const MEGAPIXEL_OPTIONS: StudioMegapixels[] = [0.6, 0.8, 1, 1.2];

export interface InspectorSectionRequest {
  section: string;
  nonce: number;
}

interface StoredDockState {
  leftTab: LeftDockTab;
  bottomTab: BottomDockTab;
  leftOpen: boolean;
  inspectorOpen: boolean;
  bottomOpen: boolean;
  megapixels: StudioMegapixels;
}

const KEY = 'h3mise-studio-docks';

const LEFT_TABS: LeftDockTab[] = ['nodes', 'assets', 'outline'];
const BOTTOM_TABS: BottomDockTab[] = ['timeline', 'queue', 'problems', 'ai', 'log'];

export function isLeftDockTab(value: unknown): value is LeftDockTab {
  return typeof value === 'string' && (LEFT_TABS as string[]).includes(value);
}

export function isBottomDockTab(value: unknown): value is BottomDockTab {
  return typeof value === 'string' && (BOTTOM_TABS as string[]).includes(value);
}

export function isMegapixels(value: unknown): value is StudioMegapixels {
  return typeof value === 'number' && (MEGAPIXEL_OPTIONS as number[]).includes(value);
}

function stored(): Partial<StoredDockState> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<StoredDockState>;
    return {
      leftTab: isLeftDockTab(parsed.leftTab) ? parsed.leftTab : undefined,
      bottomTab: isBottomDockTab(parsed.bottomTab) ? parsed.bottomTab : undefined,
      leftOpen: typeof parsed.leftOpen === 'boolean' ? parsed.leftOpen : undefined,
      inspectorOpen: typeof parsed.inspectorOpen === 'boolean' ? parsed.inspectorOpen : undefined,
      bottomOpen: typeof parsed.bottomOpen === 'boolean' ? parsed.bottomOpen : undefined,
      megapixels: isMegapixels(parsed.megapixels) ? parsed.megapixels : undefined,
    };
  } catch {
    return {};
  }
}

export const useStudioUiStore = defineStore('studioUi', () => {
  const saved = stored();
  const leftTab = ref<LeftDockTab>(saved.leftTab ?? 'nodes');
  const bottomTab = ref<BottomDockTab>(saved.bottomTab ?? 'timeline');
  const leftOpen = ref(saved.leftOpen ?? true);
  const inspectorOpen = ref(saved.inspectorOpen ?? true);
  const bottomOpen = ref(saved.bottomOpen ?? false);
  const megapixels = ref<StudioMegapixels>(saved.megapixels ?? 0.6);
  const sectionRequest = ref<InspectorSectionRequest | null>(null);
  let sectionNonce = 0;

  function openLeft(tab: LeftDockTab): void {
    leftTab.value = tab;
    leftOpen.value = true;
  }

  function openBottom(tab: BottomDockTab): void {
    bottomTab.value = tab;
    bottomOpen.value = true;
  }

  function toggleLeft(): void {
    leftOpen.value = !leftOpen.value;
  }

  function toggleInspector(): void {
    inspectorOpen.value = !inspectorOpen.value;
  }

  function toggleBottom(): void {
    bottomOpen.value = !bottomOpen.value;
  }

  /** Ask the shot inspector to scroll to a workflow section (takes / refs…). */
  function requestSection(section: string): void {
    if (!section) return;
    sectionRequest.value = { section, nonce: ++sectionNonce };
  }

  watch([leftTab, bottomTab, leftOpen, inspectorOpen, bottomOpen, megapixels], () => {
    try {
      const state: StoredDockState = {
        leftTab: leftTab.value,
        bottomTab: bottomTab.value,
        leftOpen: leftOpen.value,
        inspectorOpen: inspectorOpen.value,
        bottomOpen: bottomOpen.value,
        megapixels: megapixels.value,
      };
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* private mode / storage full: in-memory UI state still works */
    }
  });

  return {
    leftTab,
    bottomTab,
    leftOpen,
    inspectorOpen,
    bottomOpen,
    megapixels,
    sectionRequest,
    openLeft,
    openBottom,
    toggleLeft,
    toggleInspector,
    toggleBottom,
    requestSection,
  };
});
