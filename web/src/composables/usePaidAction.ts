// The single entry point for paid actions in the web app. Callers pass a
// summary (what will happen) and the actual request; the user must confirm the
// PaidActionDialog before `run` executes.

import { usePaidActionStore, type PaidActionSummary } from '../stores/paidAction';

export function usePaidAction() {
  const store = usePaidActionStore();

  async function confirm(summary: PaidActionSummary, run: () => Promise<void>): Promise<boolean> {
    const ok = await store.ask(summary);
    if (!ok) return false;
    store.submitting = true;
    try {
      await run();
      return true;
    } finally {
      store.submitting = false;
      store.close();
    }
  }

  return { confirm };
}
