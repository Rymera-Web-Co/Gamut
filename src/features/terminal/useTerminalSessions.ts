import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import { getActiveDrag, subscribeDrag, subscribeDrop } from "@/lib/dnd";
import { ipc, type ResolvedTermPath } from "@/lib/ipc";
import { isImagePath } from "@/lib/images";
import { isMac, isWindows } from "@/lib/shortcuts";
import { useSettings } from "@/lib/settings";
import type { Theme } from "@/lib/theme";
import {
  termTabLabel,
  useUiStore,
  type TermActivityKind,
  type TermPane,
  type TermTab,
} from "@/store/ui";
import { attachLinkHighlighter, linkColor, type LinkHighlighter } from "./linkHighlight";
import { notifyTerminalEvent, type NotifyTarget } from "./notify";
import { registerPathLinkProvider, stripLineSuffix } from "./pathLinks";
import { setPendingCommand, takePendingCommand } from "./pendingCommands";
import { filePathsForShell } from "./sendToTerminal";
import { FONT_FAMILY, xtermContrast, xtermTheme } from "./terminalTheme";

/** One live xterm instance + the DOM node it's mounted in, kept across switches. */
interface SessionEntry {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  /** Persistent highlighting of clickable URLs and file paths in the output. */
  linkHighlighter: LinkHighlighter;
  /** xterm link provider that makes file paths in output clickable (#255). */
  pathLinkProvider: IDisposable;
  /** True once the backend PTY has been spawned for this session. */
  spawned: boolean;
  /** Set once the entry has been torn down; gates late output callbacks. */
  disposed: boolean;
  /** Detaches the spawn output channel, if a spawn has happened. */
  disposeChannel?: () => void;
  /** GPU renderer, when WebGL is available; falls back to the DOM renderer otherwise. */
  webgl?: WebglAddon;
  /** Last (cols, rows) sent to the backend, to skip redundant resize IPC (#142). */
  lastCols?: number;
  lastRows?: number;
}

/**
 * Load the WebGL renderer, which is far cheaper per repaint than xterm's
 * default DOM renderer (#204). Falls back to the DOM renderer when WebGL is
 * unavailable, and again on `onContextLoss` (e.g. GPU driver reset), since a
 * lost context can't be recovered in place.
 */
function loadWebglAddon(entry: SessionEntry) {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      if (entry.webgl === webgl) entry.webgl = undefined;
    });
    entry.term.loadAddon(webgl);
    entry.webgl = webgl;
  } catch {
    // WebGL unavailable (e.g. no GPU context) — xterm keeps using the DOM renderer.
  }
}

/**
 * Send a `terminalResize` only when the cell grid actually changed (#142). A
 * ResizeObserver fires on every sub-cell pixel reflow (e.g. a window drag), but
 * the PTY only cares about cols/rows — so we cache the last sent pair per session
 * and skip the IPC when it's unchanged.
 */
function resizeIfChanged(id: string, e: SessionEntry) {
  if (e.term.cols === e.lastCols && e.term.rows === e.lastRows) return;
  e.lastCols = e.term.cols;
  e.lastRows = e.term.rows;
  ipc.terminalResize(id, e.term.cols, e.term.rows).catch(() => {});
}

const encoder = new TextEncoder();

/** macOS ⌘+key → control byte the shell's line editor expects. */
const TERM_META_KEYS: Record<string, string> = {
  ArrowLeft: "\x01", // ⌘← → start of line (Ctrl-A)
  ArrowRight: "\x05", // ⌘→ → end of line (Ctrl-E)
  Backspace: "\x15", // ⌘⌫ → kill to start of line (Ctrl-U)
};

/**
 * `KeyboardEvent.key` values that can appear on a character-producing physical
 * key yet are not literal text: a dead key or an in-progress IME composition.
 * Excluded from injection detection so they're never mistaken for dictation.
 */
const NON_TEXT_KEYS = new Set(["Dead", "Process", "Compose", "Unidentified"]);

/**
 * Physical key codes (`KeyboardEvent.code`) for keys that yield a single
 * printable character on a normal press — letters, digits, punctuation, space.
 * Every other physical key (numpad, navigation cluster, function row,
 * modifiers, media keys) is deliberately excluded. See {@link isInjectedText}.
 */
const CHAR_KEY_CODE =
  /^(?:Key[A-Z]|Digit[0-9]|Backquote|Minus|Equal|Bracket(?:Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash|IntlBackslash|IntlRo|IntlYen|Space)$/;

/**
 * Whether a keydown represents a whole run of literal text injected as one
 * synthetic event, rather than a genuine keystroke. Voice-control / dictation
 * tools (Fluid, macOS Voice Control) auto-paste by firing a single
 * `KeyboardEvent` whose `key` is the entire phrase ("Hello there.") while
 * `charCode` is only its first character — so xterm's keypress handler emits
 * just that first char and drops the rest (#165).
 *
 * The signature is a multi-character `key` from a physical key that can only
 * ever produce one printable character, with no chord modifier held. Gating on
 * the physical `code` rather than on a denylist of named `key` values means
 * keys whose `key` differs from their `code` are excluded for free — most
 * importantly numpad navigation when NumLock is off (e.g. code "Numpad4" → key
 * "ArrowLeft", code "NumpadEnter" → key "Enter"), which must reach xterm so it
 * can emit the proper escape sequences instead of the literal key name.
 */
function isInjectedText(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false; // a real chord, not text
  if ([...e.key].length <= 1) return false; // an ordinary single character
  if (NON_TEXT_KEYS.has(e.key)) return false; // a dead key / composition state
  return CHAR_KEY_CODE.test(e.code); // a printable physical key → injected text
}

/** macOS ⌥+key → escape sequence for word-wise editing. */
const TERM_ALT_KEYS: Record<string, string> = {
  ArrowLeft: "\x1bb", // ⌥← → back one word (ESC b)
  ArrowRight: "\x1bf", // ⌥→ → forward one word (ESC f)
  Backspace: "\x1b\x7f", // ⌥⌫ → delete previous word
};

/**
 * Find which group/tab a pane belongs to (a background pane firing an event may
 * live in any group/tab, not the active one). Used to build the notification's
 * click-to-focus target and pick a human title.
 */
function locatePane(paneId: string): { target: NotifyTarget; title: string } | null {
  const { terminals } = useUiStore.getState();
  for (const [gid, gt] of Object.entries(terminals)) {
    for (const tab of gt.tabs) {
      if (tab.panes.some((p) => p.id === paneId)) {
        return {
          target: { groupId: Number(gid), tabId: tab.id, paneId },
          title: termTabLabel(tab),
        };
      }
    }
  }
  return null;
}

/**
 * Activate a clickable URL from terminal output (#51). A GitHub **pull request**
 * URL whose `<owner>/<repo>` matches a tracked repo opens in-app in the Pull
 * Requests tab; everything else (and unresolved/untracked PRs) opens in the
 * external browser. `setActiveRepo` clears the selected PR, so `setSelectedPr`
 * must run after it.
 */
async function openTerminalLink(uri: string) {
  try {
    const ref = await ipc.githubResolvePrUrl(uri);
    if (ref) {
      const ui = useUiStore.getState();
      ui.setView("pulls");
      ui.setActiveRepo(ref.repo_id);
      ui.setSelectedPr(ref.number);
      return;
    }
  } catch {
    // Resolution failed (offline, no origin remote, etc.) — open externally.
  }
  openUrl(uri).catch(() => {});
}

/**
 * File types the in-app editor can't render usefully — opened with the OS
 * default app even when they live inside a tracked repo (#255). Images are
 * absent because the in-app viewer handles them.
 */
const OPAQUE_EXTS = new Set([
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar",
  "exe", "dmg", "pkg", "app", "deb", "rpm", "msi", "bin", "iso",
  "so", "dylib", "dll", "o", "a", "class", "jar", "war", "wasm",
  "mp3", "wav", "flac", "aac", "ogg", "m4a",
  "mp4", "mov", "avi", "mkv", "webm", "m4v",
  "woff", "woff2", "ttf", "otf", "eot",
  "sqlite", "db",
]);

/** Lowercased extension of a `/`-separated path, or "" when it has none. */
function extOf(p: string): string {
  const base = p.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Whether an in-repo file should open in the in-app editor rather than the OS. */
function opensInApp(relPath: string): boolean {
  if (isImagePath(relPath)) return true; // in-app image viewer
  return !OPAQUE_EXTS.has(extOf(relPath));
}

/**
 * Activate a clickable file path from terminal output (#255), mirroring
 * {@link openTerminalLink}. The backend resolves it (expanding `~`, resolving
 * relative paths against the pane's cwd, canonicalizing) to an absolute path and
 * the tracked repo containing it. An in-repo text file / image opens in the
 * in-app Files editor; anything else — an out-of-repo path, an in-repo binary,
 * or any directory — opens or reveals via the OS. A path that doesn't exist
 * resolves to `null`, so the click is a harmless no-op.
 */
async function openTerminalPath(raw: string, cwd: string) {
  const { path } = stripLineSuffix(raw);
  let resolved: ResolvedTermPath | null;
  try {
    resolved = await ipc.resolveTerminalPath(path, cwd);
  } catch {
    return; // couldn't resolve — leave the click inert
  }
  if (!resolved) return;
  const { abs_path, is_dir, repo_id, rel_path } = resolved;
  if (!is_dir && repo_id != null && rel_path != null && opensInApp(rel_path)) {
    // In-repo, editor-friendly: open in the Files view. `setActiveRepo` resets
    // the open file, so `setFilesPath` (consumed after it) must run last — the
    // same order the control-channel `open` deep-link uses.
    const ui = useUiStore.getState();
    ui.setActiveRepo(repo_id);
    ui.setView("files");
    ui.setFilesPath(rel_path);
    return;
  }
  if (is_dir) {
    // Directories reveal in the OS file manager. Expanding an in-repo directory
    // in the Files tree is a follow-up — no deep-link exists for it yet (#255).
    revealItemInDir(abs_path).catch(() => {});
    return;
  }
  // Out-of-repo file, or an in-repo binary: hand to the OS default app.
  openPath(abs_path).catch(() => {});
}

interface SessionsOptions {
  hostRef: RefObject<HTMLDivElement | null>;
  terminalOpen: boolean;
  activePanes: TermPane[];
  activeTab: TermTab | undefined;
  /** Stable key for the active group|tab|panes set; re-runs the layout effect. */
  paneKey: string;
  theme: Theme;
  /** The pane the user is actually viewing (focused pane of the active tab). */
  visiblePaneId: string | null;
  terminalFocusNonce: number;
  activeGroupId: number | null;
  markTermActivity: (paneId: string, kind: TermActivityKind) => void;
  clearTermActivity: (paneId: string) => void;
  setActivePane: (groupId: number, tabId: string, paneId: string) => void;
}

/**
 * Owns the ref-based xterm session manager extracted from TerminalPane (#143):
 * the persistent `pane id → live xterm` map, lazy spawn + layout, theme/resize
 * coordination, exit/bell/activity wiring, and teardown. Every pane is a
 * long-lived xterm mounted in an absolutely-positioned node and shown/hidden
 * imperatively, so scrollback and running processes survive tab/split/group
 * switches; the backend PTY runs until the pane is explicitly closed.
 *
 * Returns the set of exited ("dead") panes plus the kill/restart operations the
 * surrounding component drives from its close-tab / close-pane / restart UI.
 */
export function useTerminalSessions({
  hostRef,
  terminalOpen,
  activePanes,
  activeTab,
  paneKey,
  theme,
  visiblePaneId,
  terminalFocusNonce,
  activeGroupId,
  markTermActivity,
  clearTermActivity,
  setActivePane,
}: SessionsOptions): {
  deadKeys: Set<string>;
  killPane: (id: string) => void;
  restart: (id: string) => void;
} {
  const sessionsRef = useRef<Map<string, SessionEntry>>(new Map());
  const [deadKeys, setDeadKeys] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  // All groups' terminal layout, watched so we can reap panes removed from it.
  const allTerminals = useUiStore((s) => s.terminals);
  // Background ("silent") terminals awaiting an eager PTY spawn, watched so they
  // start their shell even though they're not the visible/active pane.
  const bgQueue = useUiStore((s) => s.terminalBgQueue);

  // Keep the latest group/tab around for the imperative click handlers.
  const ctxRef = useRef({ groupId: activeGroupId, tabId: activeTab?.id });
  ctxRef.current = { groupId: activeGroupId, tabId: activeTab?.id };

  // The one pane the user is actually looking at. Only this pane is exempt from
  // activity badging (no self-badging) and is auto-cleared when it comes in view.
  const visiblePaneRef = useRef<string | null>(visiblePaneId);
  visiblePaneRef.current = visiblePaneId;

  // Latest theme for the link highlighter's color getter (created per session).
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // Whether the Gamut window itself is focused. Focused-pane suppression only
  // makes sense while the user is actually looking at the app; when the window
  // is backgrounded (e.g. Claude finishes a task or asks for input while you're
  // in another app) the cue must fire regardless of which pane is active — the
  // exact case that was always silenced before. See #47.
  const windowFocusedRef = useRef(true);
  useEffect(() => {
    const win = getCurrentWindow();
    void win
      .isFocused()
      .then((f) => {
        windowFocusedRef.current = f;
      })
      .catch(() => {});
    const unlisten = win.onFocusChanged(({ payload }) => {
      windowFocusedRef.current = payload;
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // Whether a background-pane event should produce an audible/desktop cue.
  // Fire when the user isn't already watching it: the always-notify setting is
  // on, the window is unfocused, or this isn't the focused pane. Visual activity
  // badging stays keyed on pane visibility alone (handled at each call site).
  const shouldNotifyRef = useRef((paneId: string) => {
    if (useSettings.getState().values.terminalNotifyAlways) return true;
    if (!windowFocusedRef.current) return true;
    return paneId !== visiblePaneRef.current;
  });

  // Which currently-visible pane sits under a viewport point, in the CSS pixels
  // `getBoundingClientRect` uses. Shared by both drop paths: the OS-file-manager
  // drop (below) and the in-app file-tree drag. Callers pass CSS-pixel
  // coordinates — the OS handler converts its physical-pixel positions first.
  const paneAt = useCallback((x: number, y: number): { id: string; e: SessionEntry } | null => {
    for (const [id, e] of sessionsRef.current) {
      if (e.el.style.display === "none") continue;
      const r = e.el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { id, e };
    }
    return null;
  }, []);

  // Outline the pane being dragged over (and clear every other), so the drop
  // target is discoverable; `null` clears them all (on leave/drop/cancel). The
  // subscribeDrag path calls this on every pointermove of *any* app-wide drag,
  // so short-circuit when the target is unchanged (the common case: `null`
  // throughout an unrelated repo/tab reorder) rather than rewriting every pane's
  // style each move.
  const outlinedPaneRef = useRef<string | null>(null);
  const markTarget = useCallback((targetId: string | null) => {
    if (outlinedPaneRef.current === targetId) return;
    outlinedPaneRef.current = targetId;
    for (const [id, e] of sessionsRef.current) {
      const on = id === targetId;
      e.el.style.outline = on ? "2px dashed var(--color-primary)" : "";
      e.el.style.outlineOffset = on ? "-2px" : "";
    }
  }, []);

  function ensureEntry(pane: TermPane): SessionEntry {
    const existing = sessionsRef.current.get(pane.id);
    if (existing) return existing;
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.top = "0";
    el.style.bottom = "0";
    el.style.display = "none";
    // The host is pointer-events:none (so empty-state/overlay controls stay
    // clickable through it); panes re-enable events to receive terminal input.
    el.style.pointerEvents = "auto";
    hostRef.current!.appendChild(el);

    // Read preferences at creation time; new panes pick up changes, existing
    // ones keep their settings until recreated.
    const prefs = useSettings.getState().values;
    const term = new Terminal({
      fontSize: prefs.terminalFontSize,
      fontFamily: prefs.terminalFontFamily || FONT_FAMILY,
      cursorBlink: prefs.terminalCursorBlink,
      scrollback: prefs.terminalScrollback,
      theme: xtermTheme(theme),
      minimumContrastRatio: xtermContrast(theme),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Make http(s) URLs in output clickable. Require cmd/ctrl (matching the
    // app's other shortcuts) so plain clicks and drag-selection are undisturbed;
    // hover still underlines and shows the pointer cursor. PR links resolve
    // in-app, others open in the browser (#51). Disposed with the terminal.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (!(event.metaKey || event.ctrlKey)) return;
        void openTerminalLink(uri);
      }),
    );
    term.open(el);
    // Paste is left entirely to xterm's built-in handler: it reads the clipboard
    // text and emits the bracketed-paste frame (ESC[200~ … ESC[201~) to the PTY.
    // Crucially, an image-only clipboard (a screenshot, "Copy Image") yields empty
    // text but xterm still emits the empty bracketed frame — that frame is how a
    // program running in the pane (e.g. an interactive CLI) learns a paste
    // happened and reads the image from the OS clipboard itself. We deliberately
    // do NOT install a capture-phase paste interceptor here, so that path stays
    // unbroken.
    // Translate the macOS line-editing chords xterm doesn't emit on its own into
    // the readline/emacs control sequences the shell expects, and make
    // Shift+Enter a soft newline (#114). Returning false tells xterm to skip its
    // default handling; the bytes are written straight to the PTY instead. The
    // chords are physical-`code` matched so layout/⌥-mangling don't interfere.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Swallow the chord and write its byte sequence straight to the PTY.
      const sendSeq = (seq: string) => {
        e.preventDefault();
        ipc.terminalWrite(pane.id, encoder.encode(seq)).catch(() => {});
        return false;
      };
      // A voice-control / dictation tool injected a whole phrase as one
      // synthetic key event: forward all of it. preventDefault() (via sendSeq)
      // stops xterm's keypress from emitting just the first character and
      // suppresses the follow-up `input` event xterm would otherwise drop
      // (#165), so the text lands exactly once.
      if (isInjectedText(e)) return sendSeq(e.key);
      // Shift+Enter → LF (Enter stays CR), so multiline prompts get a newline
      // without submitting. Cross-platform.
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && e.code === "Enter") {
        return sendSeq("\n");
      }
      // The cursor/word chords below are macOS-only: elsewhere xterm already
      // emits the right sequences for Ctrl/Alt+Arrow and Backspace.
      if (!isMac()) return true;
      // ⌘ = whole-line moves (Ctrl-A/E) and kill-to-start (Ctrl-U).
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const seq = TERM_META_KEYS[e.code];
        if (seq) return sendSeq(seq);
      }
      // ⌥ = word-wise moves (ESC b / ESC f) and delete-word.
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const seq = TERM_ALT_KEYS[e.code];
        if (seq) return sendSeq(seq);
      }
      return true;
    });
    // Make file paths in output clickable too: WebLinksAddon can't be reused
    // (its LinkComputer validates every match with `new URL()`, rejecting
    // paths), so a dedicated provider handles them. Relative paths resolve
    // against the pane's cwd; cmd/ctrl-click is enforced in the handler (#255).
    const pathLinkProvider = registerPathLinkProvider(term, (p) => {
      void openTerminalPath(p, pane.cwd);
    });
    // The addon only reveals links on hover, so persistently tint + underline
    // them too — otherwise there's no hint the output is interactive (#78). The
    // highlighter underlines both URLs and file paths.
    const linkHighlighter = attachLinkHighlighter(term, () => linkColor(themeRef.current));
    term.onData((data) => {
      ipc.terminalWrite(pane.id, encoder.encode(data)).catch(() => {});
    });
    // A hidden pane ringing the xterm bell (`\a`) counts as unseen activity,
    // and fires the audible/desktop cue. The focused pane is exempt from both.
    term.onBell(() => {
      // Badge the pane only when it's hidden (no self-badging); notify on a
      // wider condition so a backgrounded window is still cued (#47).
      if (pane.id !== visiblePaneRef.current) markTermActivity(pane.id, "bell");
      if (shouldNotifyRef.current(pane.id)) {
        const loc = locatePane(pane.id);
        if (loc) notifyTerminalEvent({ kind: "bell", title: loc.title, target: loc.target });
      }
    });
    el.addEventListener("mousedown", () => {
      const { groupId, tabId } = ctxRef.current;
      if (groupId != null && tabId) setActivePane(groupId, tabId, pane.id);
    });
    const entry: SessionEntry = {
      term,
      fit,
      el,
      linkHighlighter,
      pathLinkProvider,
      spawned: false,
      disposed: false,
    };
    loadWebglAddon(entry);
    sessionsRef.current.set(pane.id, entry);
    return entry;
  }

  // Spawn the backend PTY for a session and wire its output into the xterm. Safe
  // to call whether or not the pane is currently visible (a background/"silent"
  // terminal spawns the same way) — the only difference is whether its `el` is
  // shown. No-op if already spawned. Drains any queued command once the PTY is up.
  function spawnPane(pane: TermPane, e: SessionEntry) {
    if (e.spawned) return;
    e.spawned = true;
    setDeadKeys((prev) => {
      if (!prev.has(pane.id)) return prev;
      const next = new Set(prev);
      next.delete(pane.id);
      return next;
    });
    // The spawn carries the initial grid size; seed the cache so the first
    // resize IPC only fires once the grid actually changes (#142).
    e.lastCols = e.term.cols;
    e.lastRows = e.term.rows;
    const handle = ipc.terminalSpawn(pane.id, pane.cwd, e.term.cols, e.term.rows, (bytes) => {
      // Drop bytes that arrive after the entry was torn down — the xterm
      // is disposed and `e` is stale (#139).
      if (e.disposed) return;
      e.term.write(bytes);
      // Output to a pane the user isn't viewing is unseen activity.
      if (pane.id !== visiblePaneRef.current) markTermActivity(pane.id, "output");
    });
    e.disposeChannel = handle.dispose;
    handle.ready
      .then(() => {
        if (e.disposed) return;
        // Type any command queued for this pane now that the PTY exists
        // (writing earlier would be dropped). Drains once.
        const queued = takePendingCommand(pane.id);
        if (queued) ipc.terminalWrite(pane.id, encoder.encode(queued)).catch(() => {});
      })
      .catch((err) => {
        if (e.disposed) return;
        e.term.write(`\r\n\x1b[31m${String(err)}\x1b[0m\r\n`);
      });
  }

  // Lay out the active tab's panes side by side; hide everything else. Spawn
  // each visible pane lazily once the pane is actually open.
  useEffect(() => {
    if (!hostRef.current) return;
    for (const entry of sessionsRef.current.values()) {
      entry.el.style.display = "none";
    }
    if (!terminalOpen || activePanes.length === 0) return;

    const n = activePanes.length;
    activePanes.forEach((pane, i) => {
      const e = ensureEntry(pane);
      e.el.style.display = "block";
      e.el.style.left = `${(i * 100) / n}%`;
      e.el.style.width = `${100 / n}%`;
      e.el.style.borderLeft = i > 0 ? "1px solid var(--color-border)" : "";
    });

    const raf = requestAnimationFrame(() => {
      activePanes.forEach((pane) => {
        const e = sessionsRef.current.get(pane.id);
        if (!e) return;
        try {
          e.fit.fit();
        } catch {
          /* not laid out yet */
        }
        if (!e.spawned) {
          spawnPane(pane, e);
        } else {
          resizeIfChanged(pane.id, e);
          // The PTY is already live (e.g. a control-channel request reusing
          // this terminal by name, or a background terminal now brought into
          // view): type any freshly-queued command straight away.
          const queued = takePendingCommand(pane.id);
          if (queued) ipc.terminalWrite(pane.id, encoder.encode(queued)).catch(() => {});
        }
      });
      // Focus the active pane.
      if (activeTab) {
        sessionsRef.current.get(activeTab.activePaneId)?.term.focus();
      }
    });
    return () => cancelAnimationFrame(raf);
    // `terminalFocusNonce` re-runs this so an external request (command palette,
    // notification click) re-focuses the active pane even when its tab/pane
    // state is unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalOpen, paneKey, tick, terminalFocusNonce]);

  // Re-theme all live sessions when the app theme toggles.
  useEffect(() => {
    const t = xtermTheme(theme);
    const contrast = xtermContrast(theme);
    for (const entry of sessionsRef.current.values()) {
      entry.term.options.theme = t;
      entry.term.options.minimumContrastRatio = contrast;
      // Repaint link highlights in the new theme's accent.
      entry.linkHighlighter.refresh();
    }
  }, [theme]);

  // Reflow visible panes when the pane is resized.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      for (const [id, e] of sessionsRef.current) {
        if (e.el.style.display === "none") continue;
        try {
          e.fit.fit();
        } catch {
          /* hidden / unsized */
        }
        resizeIfChanged(id, e);
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [hostRef]);

  // Insert the shell-escaped absolute path(s) of file(s) dropped from the OS
  // file manager into the pane they were dropped onto, as editable text (#232).
  // #231 turned on the webview's native drag-drop, so HTML5 drop events never
  // reach the DOM — the one webview-wide `onDragDropEvent` is the only source of
  // real filesystem paths. It fires for every drop anywhere in the window, so we
  // hit-test the drop position against each visible pane and act only when it
  // lands on one; the sidebar's repo-add listener hit-tests its own region, so
  // the two never collide. No-op outside the Tauri webview (dev/tests).
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    // Tauri types the drop position as `PhysicalPosition`, but that only holds
    // on Windows. wry sources the coordinates from the native drag event —
    // AppKit's `draggingLocation` on macOS and GTK's signal args on Linux, both
    // in *logical* points — and forwards them to Tauri unscaled. So only on
    // Windows (Win32 `ScreenToClient`, physical pixels) do we divide by the
    // device pixel ratio to reach the CSS pixels `paneAt` expects; dividing on
    // macOS would halve an already-logical value and drop the hit-test off the
    // pane, which is why the drop silently did nothing on Retina displays. (The
    // sidebar's own drop handler survives the same division only because its
    // region is anchored at the window origin.) The ratio is read per event, not
    // cached: on Windows the window can move to a differently-scaled monitor
    // mid-session, and a frozen ratio would hit-test stale coordinates.
    const at = (pos: { x: number; y: number }) => {
      const scale = isWindows() ? window.devicePixelRatio || 1 : 1;
      return paneAt(pos.x / scale, pos.y / scale);
    };

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          markTarget(at(p.position)?.id ?? null);
        } else if (p.type === "leave") {
          markTarget(null);
        } else if (p.type === "drop") {
          const hit = at(p.position);
          markTarget(null);
          if (!hit || p.paths.length === 0) return;
          const text = filePathsForShell(p.paths);
          // Stage at the shell's cursor: write straight to a live PTY, otherwise
          // queue it to drain when the pane spawns. No trailing CR — editable.
          if (hit.e.spawned) {
            ipc.terminalWrite(hit.id, encoder.encode(text)).catch(() => {});
          } else {
            setPendingCommand(hit.id, text);
          }
          // Focus the dropped-on pane so the staged path is where the user types.
          const { groupId, tabId } = ctxRef.current;
          if (groupId != null && tabId) setActivePane(groupId, tabId, hit.id);
          hit.e.term.focus();
        }
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // Bound once; reads live state through refs (sessions, ctx) and stable props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Insert the shell-escaped absolute path(s) of file(s)/folder(s) dragged from
  // the app's own editor file tree onto a terminal pane, as editable text —
  // mirroring the OS-file-manager drop above (#241, mirror of #232). The tree
  // drag is a pointer-based DnD (`src/lib/dnd.ts`), a different event system from
  // the webview's native `onDragDropEvent`, so the two drop mechanisms never
  // collide. Tree paths are repo-relative, so each is resolved to its absolute
  // path before quoting; the per-pane hit-test and dashed dragover outline are
  // reused unchanged. Pointer coordinates are already CSS pixels on every
  // platform, so no device-pixel scaling is applied.
  useEffect(() => {
    const offMove = subscribeDrag(() => {
      const drag = getActiveDrag();
      // Only a file-tree drag targets a pane; clear the outline for anything
      // else (a repo/tab reorder) and once the drag ends (drag gone → null).
      if (drag?.item.kind === "tree") {
        markTarget(paneAt(drag.x, drag.y)?.id ?? null);
      } else {
        markTarget(null);
      }
    });
    const offDrop = subscribeDrop((item, x, y) => {
      if (item.kind !== "tree") return;
      const hit = paneAt(x, y);
      markTarget(null);
      if (!hit || item.paths.length === 0) return;
      const { repoId } = item;
      const paneId = hit.id;
      // Resolve each repo-relative tree path to its absolute filesystem path
      // independently (allSettled, not all): one path that fails to resolve
      // shouldn't drop the rest of the selection. Then stage the survivors like
      // an OS-file-manager drop: shell-quoted, space-separated, no trailing CR.
      Promise.allSettled(item.paths.map((rel) => ipc.resolvePath(repoId, rel)))
        .then((results) => {
          const paths = results
            .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
            .map((r) => r.value);
          if (paths.length === 0) return;
          // The pane may have been closed during the await — re-look it up and
          // act only if it's still live, so we never write to a disposed xterm.
          const live = sessionsRef.current.get(paneId);
          if (!live) return;
          const text = filePathsForShell(paths);
          if (live.spawned) {
            ipc.terminalWrite(paneId, encoder.encode(text)).catch(() => {});
          } else {
            setPendingCommand(paneId, text);
          }
          // Focus the dropped-on pane so the staged path is where the user types.
          const { groupId, tabId } = ctxRef.current;
          if (groupId != null && tabId) setActivePane(groupId, tabId, paneId);
          live.term.focus();
        })
        .catch(() => {});
    });
    return () => {
      offMove();
      offDrop();
    };
  }, [paneAt, markTarget, setActivePane]);

  // A shell exited: note it so the active pane can offer Restart, and badge it
  // as activity if it exited while hidden.
  useEffect(() => {
    const unlisten = listen<string>("terminal-exit", (ev) => {
      const key = ev.payload;
      const e = sessionsRef.current.get(key);
      if (e) e.term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
      setDeadKeys((prev) => new Set(prev).add(key));
      if (key !== visiblePaneRef.current) markTermActivity(key, "exit");
      if (shouldNotifyRef.current(key)) {
        const loc = locatePane(key);
        if (loc) notifyTerminalEvent({ kind: "exit", title: loc.title, target: loc.target });
      }
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, [markTermActivity]);

  // Clear unseen-activity for the pane as soon as it comes into view (its tab
  // and group are selected, the panel is open, and it's the focused pane).
  useEffect(() => {
    if (visiblePaneId) clearTermActivity(visiblePaneId);
  }, [visiblePaneId, clearTermActivity]);

  function disposeEntry(id: string) {
    const e = sessionsRef.current.get(id);
    if (e) {
      // Mark disposed first so any output callback still in flight bails out,
      // then detach the spawn channel so it stops firing entirely (#139).
      e.disposed = true;
      e.disposeChannel?.();
      e.linkHighlighter.dispose();
      e.pathLinkProvider.dispose();
      e.term.dispose();
      e.el.remove();
      sessionsRef.current.delete(id);
    }
    setDeadKeys((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function killPane(id: string) {
    ipc.terminalKill(id).catch(() => {});
    disposeEntry(id);
    clearTermActivity(id);
  }

  function restart(id: string) {
    // Kill the orphaned backend PTY before tearing down the entry — otherwise
    // the old session lingers and the respawn races a still-live channel (#139).
    ipc.terminalKill(id).catch(() => {});
    disposeEntry(id);
    setTick((t) => t + 1); // recreate + respawn on next layout pass
  }

  // Reap any live session whose pane has left the layout — a tab/pane closed by
  // the close button, a control-channel `term-close`, or anything else. Killing
  // here (rather than only in the close handlers) means removing a tab from the
  // store is enough to fully tear down its shell, not just hide it.
  useEffect(() => {
    const live = new Set<string>();
    for (const g of Object.values(allTerminals)) {
      for (const t of g.tabs) for (const p of t.panes) live.add(p.id);
    }
    for (const id of [...sessionsRef.current.keys()]) {
      if (!live.has(id)) killPane(id);
    }
    // `killPane` is stable in behavior but re-created each render; depend only on
    // the layout so this runs when panes are added/removed, not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTerminals]);

  // Eagerly spawn background ("silent") terminals so a control-channel
  // `term --silent` runs its command without the user ever switching to it. For
  // each queued pane we create its (hidden) session and spawn its PTY just like a
  // visible one; the layout effect above will simply reveal it if/when the user
  // navigates to its group. A pane not yet in the layout is left queued and
  // retried when `allTerminals` next changes.
  useEffect(() => {
    if (!hostRef.current || bgQueue.length === 0) return;
    const clear = useUiStore.getState().clearBackgroundTerminal;
    for (const paneId of bgQueue) {
      let pane: TermPane | undefined;
      for (const g of Object.values(allTerminals)) {
        for (const t of g.tabs) {
          const p = t.panes.find((x) => x.id === paneId);
          if (p) pane = p;
        }
      }
      if (!pane) continue; // not in the layout yet — retry on the next change
      const e = ensureEntry(pane);
      if (!e.spawned) {
        spawnPane(pane, e);
      } else {
        // Already live (e.g. a silent reuse of an existing tab) — type any
        // freshly-queued command straight into it.
        const queued = takePendingCommand(paneId);
        if (queued) ipc.terminalWrite(paneId, encoder.encode(queued)).catch(() => {});
      }
      clear(paneId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTerminals, bgQueue]);

  return { deadKeys, killPane, restart };
}
