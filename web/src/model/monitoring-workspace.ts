/** Only changes to observation targets/time schedule paid metric requests. */
export function createMonitoringWorkspaceRequests(options: {
  key: () => string;
  ready: () => boolean;
  subscribe: (listener: () => void) => () => void;
  run: () => Promise<void>;
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
  delay?: number;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let lastKey: string | undefined;
  const schedule = options.schedule ?? setTimeout, cancel = options.cancel ?? clearTimeout;
  const clear = () => { if (timer !== undefined) cancel(timer); timer = undefined; };
  const sync = () => {
    const key = options.key();
    if (!options.ready()) { if (timer !== undefined || key !== lastKey) { clear(); lastKey = undefined; } return; }
    if (key === lastKey) return;
    lastKey = key; clear();
    if (key === undefined) return;
    timer = schedule(() => { timer = undefined; if (options.ready() && options.key() === key) void options.run(); }, options.delay ?? 300);
  };
  return { start() { if (unsubscribe) return; lastKey = undefined; unsubscribe = options.subscribe(sync); sync(); }, stop() { clear(); unsubscribe?.(); unsubscribe = undefined; lastKey = undefined; }, invalidate() { lastKey = undefined; }, sync };
}
