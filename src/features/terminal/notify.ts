import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { ipc } from "@/lib/ipc";
import { useSettings, type TerminalSound } from "@/lib/settings";
import { useUiStore, type TermActivityKind } from "@/store/ui";

/**
 * Audible + native-notification cues for background terminal events (issue #28).
 *
 * Sound playback is delegated to the host process (`play_notification_sound` in
 * `src-tauri`): the five built-in tones are synthesized there and `"custom"`
 * plays a user-supplied file. It used to run on the Web Audio API in the
 * webview, but WebKit idle-suspends an `AudioContext` once the app is
 * backgrounded or the machine goes idle, and a cue's only trigger (a background
 * event) isn't a user gesture, so the context couldn't revive and the cue was
 * silent (#119, #167). Playing natively sidesteps the webview audio lifecycle
 * entirely. Native (OS) notifications go through `tauri-plugin-notification`,
 * which respects the OS permission grant and Do-Not-Disturb; clicking one
 * focuses Gamut and the originating tab/pane.
 *
 * The focused pane is suppressed by the caller (`TerminalPane`) — you're already
 * looking at it — while the visual activity state from #27 is still set, so a
 * silenced event is never lost.
 */

// ---- Built-in sounds ------------------------------------------------------

/** Human labels for the sound picker; ids match `TERMINAL_SOUNDS` in settings.
 * The tones themselves are synthesized natively (see `commands::sound` in
 * `src-tauri`); this list only drives the picker UI. */
export const BUILTIN_SOUNDS: { id: TerminalSound; label: string }[] = [
  { id: "chime", label: "Chime" },
  { id: "ping", label: "Ping" },
  { id: "blip", label: "Blip" },
  { id: "knock", label: "Knock" },
  { id: "alert", label: "Alert" },
];

/**
 * Play a notification sound natively. `"custom"` plays the user-supplied file
 * (its path read from settings here); the other ids select a built-in tone.
 * Exposed for the Settings "Test" button; event playback goes through
 * {@link notifyTerminalEvent}. Best-effort — playback errors are logged, never
 * thrown, and the backend falls back to a built-in tone for a bad custom file.
 */
export function playSound(name: TerminalSound) {
  const customPath =
    name === "custom" ? useSettings.getState().values.terminalNotifySoundCustom : undefined;
  void ipc.playSound(name, customPath).catch((err) => {
    console.warn("notification sound failed to play:", err);
  });
}

// ---- Event orchestration --------------------------------------------------

/** Where a notification points back to, carried through the OS notification. */
export interface NotifyTarget {
  groupId: number;
  tabId: string;
  paneId: string;
}

export interface TerminalEvent {
  kind: Extract<TermActivityKind, "bell" | "exit">;
  /** The tab title (e.g. the repo/group name), used in the notification text. */
  title: string;
  target: NotifyTarget;
}

// Coalesce bursts (a chatty process ringing the bell repeatedly) into at most
// one cue per window, so a background loop can't spam sounds/popups.
const THROTTLE_MS = 400;
let lastFiredAt = 0;

/**
 * Handle a discrete background-pane event: play the configured sound and/or
 * show a desktop notification, subject to the user's settings. The caller must
 * only invoke this for *background* panes (focused-pane suppression).
 */
export function notifyTerminalEvent(ev: TerminalEvent) {
  const s = useSettings.getState().values;
  const wantsEvent = ev.kind === "exit" ? s.terminalNotifyOnExit : s.terminalNotifyOnBell;
  if (!wantsEvent) return;
  if (!s.terminalNotifySound && !s.terminalNotifyDesktop) return;

  const now = Date.now();
  if (now - lastFiredAt < THROTTLE_MS) return;
  lastFiredAt = now;

  if (s.terminalNotifySound) playSound(s.terminalNotifySoundName);
  if (s.terminalNotifyDesktop) void showDesktop(ev);
}

// ---- Desktop (OS) notifications -------------------------------------------

let actionListenerReady = false;

/** Bring the app window to the foreground and reveal the originating pane. */
function focusTarget(target: NotifyTarget) {
  const win = getCurrentWindow();
  void win.unminimize().catch(() => {});
  void win.show().catch(() => {});
  void win.setFocus().catch(() => {});

  useUiStore.getState().focusTerminal(target.groupId, target.tabId, target.paneId);
}

/**
 * Register the click handler once. Tauri delivers the clicked notification's
 * `extra` payload here, from which we recover the navigation target.
 */
async function ensureActionListener() {
  if (actionListenerReady) return;
  actionListenerReady = true;
  try {
    await onAction((n) => {
      const t = n.extra?.target as NotifyTarget | undefined;
      if (t && typeof t.groupId === "number" && t.tabId && t.paneId) focusTarget(t);
    });
  } catch {
    // Action delivery is platform-dependent; the notification itself still
    // shows even when click routing isn't available.
    actionListenerReady = false;
  }
}

async function showDesktop(ev: TerminalEvent) {
  let granted = await isPermissionGranted().catch(() => false);
  if (!granted) granted = (await requestPermission().catch(() => "denied")) === "granted";
  if (!granted) return;

  await ensureActionListener();
  const body = ev.kind === "exit" ? `${ev.title} — process exited` : `Terminal bell in ${ev.title}`;
  sendNotification({
    title: "Gamut terminal",
    body,
    extra: { target: ev.target },
  });
}

/**
 * Ask for OS notification permission up front (used when the user enables the
 * desktop-notification setting). Returns whether permission is granted.
 */
export async function ensureDesktopPermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch {
    return false;
  }
}
