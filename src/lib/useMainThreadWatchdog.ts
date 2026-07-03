import { getCurrentWindow } from "@tauri-apps/api/window";
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
 *
 * The interval is paused while the Gamut window is unfocused (issue #209): a
 * stall detector has nothing useful to detect when the user isn't looking, and
 * keeping the timer running forever pins the WebView awake instead of letting
 * it settle into a low-power idle state once backgrounded. Window focus (not
 * document visibility) is what actually changes when the user switches to
 * another app, so this follows the same `onFocusChanged` pattern already used
 * for focus-aware behavior in `useTerminalSessions.ts` (#47).
 */
const TICK_MS = 1000;
const STALL_MS = 3000;

export function useMainThreadWatchdog() {
  useEffect(() => {
    let last = performance.now();
    let id: ReturnType<typeof setInterval> | undefined;
    let disposed = false;

    const tick = () => {
      const now = performance.now();
      // How much longer than expected this tick took to fire.
      const gap = now - last - TICK_MS;
      last = now;
      if (gap > STALL_MS) {
        void ipc.recordStall(Math.round(gap)).catch(() => {});
      }
    };

    const start = () => {
      if (disposed || id !== undefined) return;
      last = performance.now();
      id = setInterval(tick, TICK_MS);
    };

    const stop = () => {
      if (id === undefined) return;
      clearInterval(id);
      id = undefined;
    };

    // Assume focused until proven otherwise, so the common case (already
    // focused) doesn't wait on an async round-trip before watching starts.
    start();

    const win = getCurrentWindow();
    void win
      .isFocused()
      .then((focused) => {
        if (!focused) stop();
      })
      .catch(() => {});
    const unlistenPromise = win.onFocusChanged(({ payload }) => {
      if (disposed) return;
      if (payload) start();
      else stop();
    });

    return () => {
      disposed = true;
      stop();
      void unlistenPromise.then((off) => off()).catch(() => {});
    };
  }, []);
}
