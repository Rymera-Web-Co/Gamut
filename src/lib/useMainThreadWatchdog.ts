import { useEffect } from "react";

import { ipc } from "@/lib/ipc";

/**
 * Coarse main-thread stall detector (issue #90). A timer that should fire every
 * `TICK_MS` measures how late it actually fires; a large overshoot means the
 * event loop was blocked (a long synchronous task, or — after it recovers — a
 * spell where the app was unresponsive). Stalls past `STALL_MS` are recorded to
 * the backend diagnostics log so they show up in an exported bundle even if the
 * user never managed to interact during the freeze.
 *
 * This catches stalls in the WebView/JS event loop. A block in the native Rust
 * main thread (the #88 class of hang) may not stall JS, so this is a
 * complementary signal, not a complete one.
 */
const TICK_MS = 1000;
const STALL_MS = 3000;

export function useMainThreadWatchdog() {
  useEffect(() => {
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      // How much longer than expected this tick took to fire.
      const gap = now - last - TICK_MS;
      last = now;
      if (gap > STALL_MS) {
        void ipc.recordStall(Math.round(gap)).catch(() => {});
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);
}
