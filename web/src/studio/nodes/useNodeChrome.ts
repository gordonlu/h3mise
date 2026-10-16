import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import type { NodeProps } from '@vue-flow/core';
import type { CanvasNode } from '@h3mise/shared';
import { useStudioStore } from '../../stores/studio';

/** Shared read-only chrome inputs for a Studio node component. */
export function useNodeChrome(props: NodeProps<{ node: CanvasNode }>) {
  const store = useStudioStore();
  const { lod } = storeToRefs(store);
  const node = computed(() => props.data.node);
  const selected = computed(() => store.selection.includes(node.value.id));
  return { node, selected, lod };
}
