/**
 * Transient store for a command to type into a terminal pane once its PTY is
 * live. Kept here, deliberately *outside* the Zustand terminal layout, so it's
 * never persisted: the command must run exactly once when the pane first
 * spawns, and must not replay when a saved layout is restored on the next
 * launch.
 *
 * A terminal-open request opens a tab (which mints a pane id) and queues the
 * command against that id; the session manager drains it after the spawn IPC
 * resolves and writes it straight to the PTY.
 */
const pending = new Map<string, string>();

/** Queue raw bytes (command text, with or without a trailing CR) for `paneId`. */
export function setPendingCommand(paneId: string, data: string): void {
  pending.set(paneId, data);
}

/** Take and clear the queued command for `paneId`, if any. */
export function takePendingCommand(paneId: string): string | undefined {
  const data = pending.get(paneId);
  pending.delete(paneId);
  return data;
}
