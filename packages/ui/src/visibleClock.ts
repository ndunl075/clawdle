interface VisibleClockOptions {
  active: boolean;
  deadline?: number;
  readMono: () => number;
  onTime: (monoMs: number) => void;
  onDay: (utcMs: number) => void;
  onDeadline: () => void;
}

// Display time is local presentation state. Only the deadline needs a durable command.
export function observeVisibleClock(options: VisibleClockOptions): () => void {
  let clockTimer: ReturnType<typeof setTimeout> | undefined;
  let dayTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineSent = false;
  const clear = () => { clearTimeout(clockTimer); clearTimeout(dayTimer); };
  const finish = () => {
    if (!deadlineSent) { deadlineSent = true; options.onDeadline(); }
  };
  const updateClock = () => {
    const now = options.readMono();
    options.onTime(now);
    if (options.deadline !== undefined && now >= options.deadline) {
      finish();
      return;
    }
    clockTimer = setTimeout(updateClock, Math.min(1000, options.deadline === undefined ? 1000 : options.deadline - now));
  };
  const updateDay = () => {
    const now = Date.now();
    options.onDay(now);
    dayTimer = setTimeout(updateDay, 86400000 - now % 86400000);
  };
  const resume = () => {
    clear();
    if (document.visibilityState !== 'visible') return;
    updateDay();
    if (options.active) updateClock();
  };
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('clawdle-window-presented', resume);
  // Visibility only suspends rendering. The durable run boundary must still occur.
  if (options.active && options.deadline !== undefined)
    deadlineTimer = setTimeout(finish, Math.max(0, options.deadline - options.readMono()));
  resume();
  return () => {
    clear();
    clearTimeout(deadlineTimer);
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('clawdle-window-presented', resume);
  };
}
