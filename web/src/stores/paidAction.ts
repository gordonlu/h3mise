// Paid-action confirmation. This store + PaidActionDialog + usePaidAction are
// the ONLY place the web calls a paid endpoint (render / storyboard generate /
// auto-produce / retry-without-task). See AGENTS.md render safety rules.

import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ProviderVerification } from '@h3mise/shared';

export interface PaidActionSummary {
  title: string;
  providerName: string;
  providerRegion?: string | null;
  mock?: boolean;
  verification?: ProviderVerification['status'] | null;
  target?: string;
  mode?: string;
  durationSeconds?: number;
  aspectRatio?: string;
  megapixels?: number;
  references?: string[];
  preflight?: { blocked: boolean; risk?: string | null } | null;
  estimatedCost?: string | null;
  taskCount?: number;
  /** When set, the dialog is a blocker: confirm is disabled and the message shows. */
  blocker?: string | null;
}

interface Pending extends PaidActionSummary {
  resolve: (ok: boolean) => void;
  openedAt: number;
}

export const usePaidActionStore = defineStore('paidAction', () => {
  const pending = ref<Pending | null>(null);
  const confirmed = ref(false);
  const submitting = ref(false);

  function ask(summary: PaidActionSummary): Promise<boolean> {
    return new Promise((resolve) => {
      confirmed.value = false;
      submitting.value = false;
      pending.value = { ...summary, resolve, openedAt: Date.now() };
    });
  }

  function confirm(): void {
    if (!pending.value || confirmed.value || submitting.value) return;
    confirmed.value = true;
    pending.value.resolve(true);
  }

  function cancel(): void {
    if (!pending.value || submitting.value) return;
    pending.value.resolve(false);
    pending.value = null;
  }

  /** Called by the caller after the run settles, to dismiss the dialog. */
  function close(): void {
    pending.value = null;
    submitting.value = false;
    confirmed.value = false;
  }

  return { pending, confirmed, submitting, ask, confirm, cancel, close };
});
