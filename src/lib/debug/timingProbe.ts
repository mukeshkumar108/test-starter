export type TimingProbeEntry = {
  scope: string;
  at: string;
  data: Record<string, number | string | boolean | null>;
};

function getStore() {
  const globalStore = globalThis as {
    __timingProbeEntries?: TimingProbeEntry[];
  };
  if (!Array.isArray(globalStore.__timingProbeEntries)) {
    globalStore.__timingProbeEntries = [];
  }
  return globalStore.__timingProbeEntries;
}

export function recordTimingProbe(
  scope: string,
  data: Record<string, number | string | boolean | null>
) {
  const store = getStore();
  store.push({
    scope,
    at: new Date().toISOString(),
    data,
  });
  if (store.length > 100) {
    store.splice(0, store.length - 100);
  }
}

export function getLatestTimingProbe(scope: string) {
  const store = getStore();
  for (let i = store.length - 1; i >= 0; i -= 1) {
    if (store[i].scope === scope) return store[i];
  }
  return null;
}

export function clearTimingProbes(scope?: string) {
  const store = getStore();
  if (!scope) {
    store.length = 0;
    return;
  }
  for (let i = store.length - 1; i >= 0; i -= 1) {
    if (store[i].scope === scope) {
      store.splice(i, 1);
    }
  }
}
