/** Quiet time after the last output chunk before a pane reads as idle. */
export const BUSY_IDLE_MS = 2000;
/** Output this soon after a keystroke or resize is echo or a redraw, not work. */
export const ECHO_WINDOW_MS = 250;

/** Per-pane busy/idle state machine fed by PTY output. */
export interface BusyTracker {
  /** Note a keystroke or resize, so the output it causes is ignored. */
  suppress(): void;
  /** Note an output chunk. */
  output(): void;
  /** Go idle now (process exit or teardown). */
  stop(): void;
}

/**
 * Calls `onChange(true)` on the first output after idle, and `onChange(false)`
 * after {@link BUSY_IDLE_MS} with no output. One timer per busy spell, not per chunk.
 */
export function createBusyTracker(
  onChange: (busy: boolean) => void,
  now: () => number = () => performance.now(),
): BusyTracker {
  let suppressedAt = -Infinity;
  let lastOutputAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const check = () => {
    const quiet = now() - lastOutputAt;
    if (quiet < BUSY_IDLE_MS) {
      timer = setTimeout(check, BUSY_IDLE_MS - quiet);
      return;
    }
    timer = undefined;
    onChange(false);
  };

  return {
    suppress() {
      suppressedAt = now();
    },
    output() {
      if (now() - suppressedAt < ECHO_WINDOW_MS) return;
      lastOutputAt = now();
      if (timer !== undefined) return;
      onChange(true);
      timer = setTimeout(check, BUSY_IDLE_MS);
    },
    stop() {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      onChange(false);
    },
  };
}
