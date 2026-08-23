// Keyed async mutex — serializes check-then-act sequences per key inside the
// single local server process. Used to close the race between the preflight
// duplicate-job check and queue.submit(): two overlapping /api/render requests
// for the same shot must never both pass the gate and double-charge.

export type KeyedMutex = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

export function createKeyedMutex(): KeyedMutex {
  const chains = new Map<string, Promise<unknown>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(key) ?? Promise.resolve();
    const task = prev.catch(() => undefined).then(fn);
    const settled = task.catch(() => undefined);
    chains.set(key, settled);
    void settled.then(() => {
      // Prune only when this is still the tail — later entries keep the chain.
      if (chains.get(key) === settled) chains.delete(key);
    });
    await task;
    return task as Promise<T>;
  };
}
