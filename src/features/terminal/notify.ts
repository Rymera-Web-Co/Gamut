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
 * Sound is synthesized with the Web Audio API rather than bundled audio files,
 * so v1 ships a curated set of built-in tones with no asset pipeline or
 * format/size validation to settle. Native (OS) notifications go through
 * `tauri-plugin-notification`, which respects the OS permission grant and
 * Do-Not-Disturb; clicking one focuses Gamut and the originating tab/pane.
 *
 * The focused pane is suppressed by the caller (`TerminalPane`) — you're already
 * looking at it — while the visual activity state from #27 is still set, so a
 * silenced event is never lost.
 */

// ---- Built-in sounds ------------------------------------------------------

/** Human labels for the sound picker; ids match `TERMINAL_SOUNDS` in settings. */
export const BUILTIN_SOUNDS: { id: TerminalSound; label: string }[] = [
  { id: "chime", label: "Chime" },
  { id: "ping", label: "Ping" },
  { id: "blip", label: "Blip" },
  { id: "knock", label: "Knock" },
  { id: "alert", label: "Alert" },
];

/** One scheduled tone: frequency, start offset and duration (seconds). */
interface Tone {
  freq: number;
  at: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
}

/** Each synthesized sound as a short sequence of enveloped tones. */
const SOUND_RECIPES: Record<Exclude<TerminalSound, "custom">, Tone[]> = {
  chime: [
    { freq: 880, at: 0, dur: 0.18, type: "sine" },
    { freq: 1318.5, at: 0.12, dur: 0.28, type: "sine" },
  ],
  ping: [{ freq: 1568, at: 0, dur: 0.16, type: "sine" }],
  blip: [{ freq: 660, at: 0, dur: 0.09, type: "square", gain: 0.18 }],
  knock: [
    { freq: 180, at: 0, dur: 0.12, type: "triangle", gain: 0.4 },
    { freq: 150, at: 0.14, dur: 0.14, type: "triangle", gain: 0.4 },
  ],
  alert: [
    { freq: 988, at: 0, dur: 0.12, type: "triangle" },
    { freq: 988, at: 0.18, dur: 0.12, type: "triangle" },
  ],
};

let audioCtx: AudioContext | null = null;

/** Lazily create the shared AudioContext on first playback. */
function ctx(): AudioContext | null {
  type WithWebkit = typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  const Ctor = window.AudioContext ?? (window as WithWebkit).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  return audioCtx;
}

/**
 * Resume a suspended context before scheduling. Autoplay policies can leave the
 * context suspended until a gesture; a background event (Claude finishing while
 * the window is unfocused) isn't a gesture, so we must await the resume or the
 * tone is scheduled against a stalled clock and never sounds. Best-effort — a
 * rejected resume just means playback is a no-op, never a thrown error.
 */
async function ensureRunning(ac: AudioContext): Promise<void> {
  if (ac.state === "suspended") {
    try {
      await ac.resume();
    } catch {
      /* still suspended — playback will be a silent no-op */
    }
  }
}

// Loaded custom sound, keyed by path so we read it from disk only when the
// chosen file changes (not on every event).
// Decoded custom sound, keyed by path so we read+decode from disk only when the
// chosen file changes (not on every event).
let customCache: { path: string; buffer: AudioBuffer } | null = null;

/**
 * Play the user-chosen custom sound file. The bytes are read over IPC and
 * decoded into the shared AudioContext, then played through a buffer source —
 * the same path the synthesized tones use. This avoids `HTMLAudioElement`'s
 * autoplay gating (which would block playback for a background event, since
 * it's not triggered by a click) and the MIME-sniffing pitfalls of an untyped
 * Blob URL in the webview.
 */
async function playCustom(path: string) {
  if (!path) return;
  const ac = ctx();
  if (!ac) return;
  await ensureRunning(ac);
  try {
    if (!customCache || customCache.path !== path) {
      const buf = await ipc.readAudioFile(path);
      // decodeAudioData detaches the buffer; we cache the decoded result.
      const buffer = await ac.decodeAudioData(buf);
      customCache = { path, buffer };
    }
    const src = ac.createBufferSource();
    src.buffer = customCache.buffer;
    const gain = ac.createGain();
    gain.gain.value = 0.8;
    src.connect(gain).connect(ac.destination);
    src.start();
  } catch (err) {
    // Unreadable / too large / undecodable — log for debugging and fall back to
    // a built-in tone so a real event is never silently dropped.
    console.warn("custom notification sound failed to play:", err);
    playSound("chime");
  }
}

/**
 * Play a notification sound. `"custom"` plays the user-supplied file; the other
 * ids are synthesized. Exposed for the Settings "Test" button; event playback
 * goes through {@link notifyTerminalEvent}. Best-effort — silently no-ops if the
 * browser has no Web Audio support.
 */
export function playSound(name: TerminalSound) {
  if (name === "custom") {
    void playCustom(useSettings.getState().values.terminalNotifySoundCustom);
    return;
  }
  const ac = ctx();
  if (!ac) return;
  const recipe = SOUND_RECIPES[name] ?? SOUND_RECIPES.chime;
  // Resume first so a background event schedules against a running clock; the
  // tones are scheduled in the continuation since `currentTime` only advances
  // once the context is running.
  void ensureRunning(ac).then(() => {
    const now = ac.currentTime;
    for (const tone of recipe) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = tone.type ?? "sine";
      osc.frequency.value = tone.freq;
      const peak = tone.gain ?? 0.25;
      const start = now + tone.at;
      const end = start + tone.dur;
      // Linear attack + exponential decay keeps each tone click-free.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(peak, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain).connect(ac.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    }
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
