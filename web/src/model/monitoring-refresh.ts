/** Schedule after completion, with bounded retry delays; no overlapping metric requests. */
export function createMonitoringRefresh(options: {
  interval: number;
  run: () => Promise<boolean>;
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  let stopped = true, running = false, failures = 0, generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const enqueue = (g: number) => { if (!stopped && g === generation) timer = schedule(() => { void tick(g); }, Math.min(1200000, options.interval * 2 ** Math.min(failures, 2))); };
  const tick = async (g: number) => {
    timer = undefined;
    if (stopped || g !== generation) return;
    if (running) { enqueue(g); return; }
    running = true;
    try { const success = await options.run(); if (g === generation) failures = success ? 0 : failures + 1; }
    catch { if (g === generation) failures++; }
    finally { running = false; enqueue(g); }
  };
  return {
    start() { if (!stopped) return; stopped = false; generation++; enqueue(generation); },
    stop() { stopped = true; generation++; if (timer !== undefined) cancel(timer); timer = undefined; },
  };
}
