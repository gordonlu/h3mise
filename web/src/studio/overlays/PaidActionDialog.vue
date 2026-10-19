<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { usePaidActionStore } from '../../stores/paidAction';
import { t } from '../../stores/locale';

const store = usePaidActionStore();
const router = useRouter();
const armed = ref(false);

watch(
  () => store.pending,
  (pending) => {
    armed.value = false;
    if (!pending) return;
    const timer = setTimeout(() => {
      armed.value = true;
    }, 600);
    return () => clearTimeout(timer);
  },
  { immediate: true },
);

const verificationBad = computed(() =>
  !store.pending?.mock &&
  (store.pending?.verification === 'unconfigured' || store.pending?.verification === 'failed'),
);
const unverified = computed(() => store.pending?.verification === 'nodes_detected');
const canConfirm = computed(
  () => Boolean(store.pending) && !store.pending?.blocker && !verificationBad.value && armed.value && !store.confirmed && !store.submitting,
);

function onKey(e: KeyboardEvent): void {
  if (!store.pending) return;
  if (e.key === 'Escape') store.cancel();
  if (e.key === 'Enter' && canConfirm.value) store.confirm();
}

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));

function goSettings(): void {
  store.cancel();
  void router.push('/settings');
}
</script>

<template>
  <Teleport to="body">
    <div v-if="store.pending" class="dlg-backdrop" @click.self="store.cancel()">
      <div class="dlg paid-dlg" role="alertdialog" aria-label="paid action">
        <div class="dlg-head">{{ store.pending.title }}</div>
        <div class="dlg-body paid-body">
          <div class="paid-row">
            <span class="paid-k">Provider</span>
            <span class="paid-v">
              {{ store.pending.providerName }}
              <template v-if="store.pending.providerRegion">（{{ store.pending.providerRegion }}）</template>
              <span v-if="store.pending.verification" class="paid-verif" :class="store.pending.verification">{{ store.pending.verification }}</span>
            </span>
          </div>
          <div v-if="store.pending.target" class="paid-row">
            <span class="paid-k">{{ t('paid.target') }}</span><span class="paid-v">{{ store.pending.target }}</span>
          </div>
          <div v-if="store.pending.mode" class="paid-row">
            <span class="paid-k">{{ t('paid.mode') }}</span><span class="paid-v">{{ store.pending.mode }}</span>
          </div>
          <div class="paid-row">
            <span class="paid-k">{{ t('paid.params') }}</span>
            <span class="paid-v">
              <template v-if="store.pending.durationSeconds">{{ store.pending.durationSeconds }}s · </template>
              <template v-if="store.pending.aspectRatio">{{ store.pending.aspectRatio }}</template>
              <template v-if="store.pending.megapixels"> · {{ store.pending.megapixels }} MP</template>
            </span>
          </div>
          <div v-if="store.pending.references?.length" class="paid-row">
            <span class="paid-k">{{ t('paid.references') }}</span><span class="paid-v">{{ store.pending.references.join('、') }}</span>
          </div>
          <div class="paid-row">
            <span class="paid-k">{{ t('paid.preflight') }}</span>
            <span class="paid-v" :class="{ bad: store.pending.preflight?.blocked }">
              {{ store.pending.preflight ? (store.pending.preflight.blocked ? t('paid.preflightBlocked') : t('paid.preflightPass')) : t('paid.preflightNone') }}
            </span>
          </div>
          <div v-if="store.pending.estimatedCost" class="paid-row">
            <span class="paid-k">{{ t('paid.cost') }}</span><span class="paid-v">{{ store.pending.estimatedCost }} <small>({{ t('paid.costHint') }})</small></span>
          </div>
          <div v-if="store.pending.taskCount" class="paid-row">
            <span class="paid-k">{{ t('paid.tasks') }}</span><span class="paid-v">{{ store.pending.taskCount }}</span>
          </div>

          <p v-if="store.pending.blocker" class="paid-blocker">{{ store.pending.blocker }}</p>
          <p v-if="!store.pending.mock" class="paid-warn">{{ t('paid.realWarning') }}</p>
          <p v-if="unverified" class="paid-note">{{ t('paid.firstSubmit') }}</p>
          <p v-if="verificationBad" class="paid-blocker">
            {{ t('paid.profileBad') }}
            <button class="paid-link" @click="goSettings">{{ t('paid.goSettings') }}</button>
          </p>
        </div>
        <div class="dlg-foot">
          <button :disabled="store.submitting" @click="store.cancel()">{{ t('common.cancel') }}</button>
          <button class="primary" :disabled="!canConfirm" @click="store.confirm()">
            {{ store.submitting ? t('paid.submitting') : (store.pending.mock ? t('paid.confirmMock') : t('paid.confirm')) }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.paid-dlg { width: min(520px, calc(100vw - 40px)); }
.paid-body { display: grid; gap: 6px; }
.paid-row { display: flex; gap: 12px; align-items: baseline; font-size: 13px; }
.paid-k { flex: none; width: 88px; color: var(--text-3); }
.paid-v { flex: 1; min-width: 0; color: var(--text); word-break: break-word; }
.paid-v.bad { color: var(--bad); }
.paid-verif { margin-left: 6px; font-size: 11px; padding: 1px 6px; border-radius: 999px; background: var(--bg-muted); color: var(--text-3); }
.paid-verif.verified { background: var(--ok-soft); color: var(--ok); }
.paid-verif.failed, .paid-verif.unconfigured { background: var(--bad-soft); color: var(--bad); }
.paid-verif.nodes_detected { background: var(--warn-soft); color: var(--warn); }
.paid-warn { margin: 8px 0 0; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--warn-soft); color: var(--warn); font-size: 12px; }
.paid-blocker { margin: 8px 0 0; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--bad-soft); color: var(--bad); font-size: 12px; }
.paid-note { margin: 8px 0 0; font-size: 12px; color: var(--text-3); }
.paid-link { margin-left: 6px; background: none; border: none; color: var(--accent-text); cursor: pointer; text-decoration: underline; font-size: 12px; }
</style>
