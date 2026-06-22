import { useEffect, useRef, useState, type DragEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Minimize2, Plus, RotateCw, SplitSquareHorizontal, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";

import { useGroups, useRepos } from "@/features/repos/api";
import { clearDrag, getDrag, setDrag } from "@/lib/dnd";
import { visibleRepos } from "@/lib/groupRepos";
import { ipc } from "@/lib/ipc";
import { isMac } from "@/lib/shortcuts";
import { useSettings } from "@/lib/settings";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import {
  ACTIVITY_PRIORITY,
  termTabLabel,
  useUiStore,
  type TermActivityKind,
  type TermPane,
  type TermTab,
} from "@/store/ui";
import { ActivityDot } from "./activity";
import { attachLinkHighlighter, linkColor, type LinkHighlighter } from "./linkHighlight";
import { notifyTerminalEvent, type NotifyTarget } from "./notify";

/** One live xterm instance + the DOM node it's mounted in, kept across switches. */
interface SessionEntry {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  /** Persistent highlighting of clickable URLs in the output. */
  linkHighlighter: LinkHighlighter;
  /** True once the backend PTY has been spawned for this session. */
  spawned: boolean;
}

const FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, "Cascadia Code", "Roboto Mono", monospace';

/** xterm palette tuned to the app's light/dark surfaces. */
function xtermTheme(theme: Theme) {
  return theme === "dark"
    ? {
        background: "#1c2128",
        foreground: "#adbac7",
        cursor: "#adbac7",
        selectionBackground: "#3392ff55",
      }
    : {
        background: "#f4f2ec",
        foreground: "#2b2b28",
        cursor: "#2b2b28",
        selectionBackground: "#2563eb33",
      };
}

const encoder = new TextEncoder();

/** macOS ⌘+key → control byte the shell's line editor expects. */
const TERM_META_KEYS: Record<string, string> = {
  ArrowLeft: "\x01", // ⌘← → start of line (Ctrl-A)
  ArrowRight: "\x05", // ⌘→ → end of line (Ctrl-E)
  Backspace: "\x15", // ⌘⌫ → kill to start of line (Ctrl-U)
};

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
 * The integrated terminal pane: a per-group set of tabs, each with one or more
 * side-by-side split panes. Every pane is a long-lived xterm instance mounted
 * in an absolutely-positioned node and shown/hidden imperatively, so scrollback
 * and running processes survive tab, split and group switches; the matching
 * backend PTY keeps running until the pane is explicitly closed or the app exits.
 */
export function TerminalPane() {
  const terminalOpen = useUiStore((s) => s.terminalOpen);
  const terminalMaximized = useUiStore((s) => s.terminalMaximized);
  const toggleTerminalMaximized = useUiStore((s) => s.toggleTerminalMaximized);
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const terminals = useUiStore((s) => s.terminals);
  const setTerminalOpen = useUiStore((s) => s.setTerminalOpen);
  const addTerminalTab = useUiStore((s) => s.addTerminalTab);
  const splitTerminal = useUiStore((s) => s.splitTerminal);
  const selectTerminalTab = useUiStore((s) => s.selectTerminalTab);
  const reorderTerminalTab = useUiStore((s) => s.reorderTerminalTab);
  const renameTerminalTab = useUiStore((s) => s.renameTerminalTab);
  const setActivePane = useUiStore((s) => s.setActivePane);
  const closeTerminalTab = useUiStore((s) => s.closeTerminalTab);
  const closeTerminalPane = useUiStore((s) => s.closeTerminalPane);
  const termActivity = useUiStore((s) => s.termActivity);
  const markTermActivity = useUiStore((s) => s.markTermActivity);
  const clearTermActivity = useUiStore((s) => s.clearTermActivity);
  const terminalFocusNonce = useUiStore((s) => s.terminalFocusNonce);
  const theme = useTheme((s) => s.theme);

  const repos = useRepos();
  const groups = useGroups();
  const repoList = repos.data ?? [];
  const groupList = groups.data ?? [];

  const hostRef = useRef<HTMLDivElement>(null);
  const sessionsRef = useRef<Map<string, SessionEntry>>(new Map());
  const [deadKeys, setDeadKeys] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  // Inline tab-rename state: which tab's label is being edited, and its draft.
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  // While reordering by drag, which tab the cursor is over and on which side —
  // drives the insertion line (the strip is horizontal, so left/right).
  const [dragOverTab, setDragOverTab] = useState<{
    id: string;
    edge: "left" | "right";
  } | null>(null);

  const gt = activeGroupId != null ? terminals[activeGroupId] : undefined;
  const activeTab = gt?.tabs.find((t) => t.id === gt.activeTabId);
  const activePanes = activeTab?.panes ?? [];
  // Stable dep so the layout effect re-runs on tab/split changes.
  const paneKey = `${activeGroupId}|${activeTab?.id ?? ""}|${activePanes
    .map((p) => p.id)
    .join(",")}`;

  // Keep the latest group/tab around for the imperative click handlers.
  const ctxRef = useRef({ groupId: activeGroupId, tabId: activeTab?.id });
  ctxRef.current = { groupId: activeGroupId, tabId: activeTab?.id };

  // The one pane the user is actually looking at: the focused pane of the
  // active tab while the panel is open. Only this pane is exempt from activity
  // badging (no self-badging) and is auto-cleared when it comes into view.
  const visiblePaneId = terminalOpen && activeTab ? activeTab.activePaneId : null;
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
    // The addon only reveals links on hover, so persistently tint + underline
    // them too — otherwise there's no hint the output is interactive (#78).
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
    const entry: SessionEntry = { term, fit, el, linkHighlighter, spawned: false };
    sessionsRef.current.set(pane.id, entry);
    return entry;
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
          e.spawned = true;
          setDeadKeys((prev) => {
            if (!prev.has(pane.id)) return prev;
            const next = new Set(prev);
            next.delete(pane.id);
            return next;
          });
          ipc
            .terminalSpawn(pane.id, pane.cwd, e.term.cols, e.term.rows, (bytes) => {
              e.term.write(bytes);
              // Output to a pane the user isn't viewing is unseen activity.
              if (pane.id !== visiblePaneRef.current) markTermActivity(pane.id, "output");
            })
            .catch((err) => {
              e.term.write(`\r\n\x1b[31m${String(err)}\x1b[0m\r\n`);
            });
        } else {
          ipc.terminalResize(pane.id, e.term.cols, e.term.rows).catch(() => {});
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
    for (const entry of sessionsRef.current.values()) {
      entry.term.options.theme = t;
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
        ipc.terminalResize(id, e.term.cols, e.term.rows).catch(() => {});
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

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
      e.linkHighlighter.dispose();
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
    disposeEntry(id);
    setTick((t) => t + 1); // recreate + respawn on next layout pass
  }

  // The cwd/title a brand-new tab should default to: the active group's bound
  // folder, else the first repo shown in that group.
  function defaultTarget(): { cwd: string; title: string } | null {
    const group = groupList.find((g) => g.id === activeGroupId);
    if (group?.folder_path) return { cwd: group.folder_path, title: group.name };
    const first = visibleRepos(repoList, group).find((r) => !r.missing);
    return first ? { cwd: first.path, title: first.name } : null;
  }

  function handleNewTab() {
    const target = defaultTarget();
    if (target && activeGroupId != null) {
      addTerminalTab(activeGroupId, target.cwd, target.title);
    }
  }

  function handleSplit() {
    if (activeGroupId == null || !activeTab) return;
    const active =
      activeTab.panes.find((p) => p.id === activeTab.activePaneId) ?? activeTab.panes[0];
    splitTerminal(activeGroupId, active.cwd);
  }

  function beginRename(tab: TermTab) {
    setEditingTabId(tab.id);
    setDraftTitle(termTabLabel(tab));
  }

  // Commit the draft (blank reverts to the default); a no-op once editing ended,
  // so the blur that fires after Enter/Esc doesn't double-apply.
  function commitRename() {
    if (editingTabId == null || activeGroupId == null) return;
    renameTerminalTab(activeGroupId, editingTabId, draftTitle);
    setEditingTabId(null);
  }

  function handleCloseTab(tabId: string) {
    if (activeGroupId == null) return;
    const tab = gt?.tabs.find((t) => t.id === tabId);
    tab?.panes.forEach((p) => killPane(p.id));
    closeTerminalTab(activeGroupId, tabId);
  }

  function handleClosePane(paneId: string) {
    if (activeGroupId == null || !activeTab) return;
    killPane(paneId);
    closeTerminalPane(activeGroupId, activeTab.id, paneId);
  }

  // Terminal keyboard shortcuts. Handled here (not in the global hook) because
  // closing a tab must also kill its panes' PTYs — only this component can.
  //   ⌘T new tab (opens the pane if hidden)   ⌘W close active tab
  //   ⌘⇧] / ⌘⇧[ next / prev tab   ⌘⌥1–9 jump to tab (9 = last)   ⌘D split
  // Everything but ⌘T is scoped to the terminal pane having focus, so it never
  // steals keys from the editor (e.g. Monaco's own ⌘D).
  // Built once per render and reused as both the initializer and the live
  // value, so we don't allocate a throwaway snapshot every render.
  const shortcuts = {
    handleNewTab,
    handleSplit,
    handleCloseTab,
    selectTerminalTab,
    activeGroupId,
    gt,
    activeTab,
  };
  const shortcutRef = useRef(shortcuts);
  shortcutRef.current = shortcuts;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const s = shortcutRef.current;
      // ⌘T opens / adds a tab from anywhere.
      if (!e.altKey && !e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        s.handleNewTab();
        return;
      }
      // The rest act on the focused terminal pane only.
      const focused = hostRef.current?.contains(document.activeElement) ?? false;
      if (!focused || s.activeGroupId == null) return;
      const tabs = s.gt?.tabs ?? [];
      if (!e.altKey && !e.shiftKey && e.code === "KeyW") {
        // Always swallow ⌘W while the terminal is focused so it can't fall
        // through to closing the Tauri window; no-op when there's no tab.
        e.preventDefault();
        if (s.activeTab) s.handleCloseTab(s.activeTab.id);
        return;
      }
      if (!e.altKey && !e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        s.handleSplit();
        return;
      }
      if (e.shiftKey && !e.altKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
        if (tabs.length && s.gt?.activeTabId) {
          e.preventDefault();
          const i = tabs.findIndex((t) => t.id === s.gt!.activeTabId);
          const dir = e.code === "BracketRight" ? 1 : -1;
          const next = tabs[(i + dir + tabs.length) % tabs.length];
          s.selectTerminalTab(s.activeGroupId, next.id);
        }
        return;
      }
      if (e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        const n = Number(e.code.slice(5));
        const idx = n === 9 ? tabs.length - 1 : n - 1;
        if (tabs[idx]) {
          e.preventDefault();
          s.selectTerminalTab(s.activeGroupId, tabs[idx].id);
        }
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The most salient unseen-activity kind across a tab's panes, if any.
  function tabActivity(tab: TermTab): TermActivityKind | undefined {
    let best: TermActivityKind | undefined;
    for (const p of tab.panes) {
      const k = termActivity[p.id];
      if (k && (!best || ACTIVITY_PRIORITY[k] > ACTIVITY_PRIORITY[best])) best = k;
    }
    return best;
  }

  // Which side of a tab the cursor is on — before (left) or after (right).
  function tabEdgeFor(e: DragEvent<HTMLDivElement>): "left" | "right" {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientX > rect.left + rect.width / 2 ? "right" : "left";
  }

  const tabs = gt?.tabs ?? [];
  const canNewTab = defaultTarget() != null;
  const n = activePanes.length;
  const activeDead = activeTab != null && deadKeys.has(activeTab.activePaneId);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{ background: xtermTheme(theme).background }}
    >
      {/* Tab strip + controls. */}
      <div
        className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-sidebar)] text-xs"
        // Double-clicking the empty part of the bar toggles maximize, mirroring
        // the desktop window-title convention. The guard limits this to the bar
        // itself so tab labels (rename) and control buttons keep their handlers.
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget) toggleTerminalMaximized();
        }}
      >
        {tabs.map((tab) => {
          // Inactive tabs surface unseen background activity with a dot; the
          // active tab's focused pane is already "seen" (and cleared).
          const tabKind = tab.id === gt?.activeTabId ? undefined : tabActivity(tab);
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === gt?.activeTabId}
              // Don't start a drag while the label is being renamed — the input
              // needs normal text selection/caret behaviour.
              draggable={editingTabId !== tab.id}
              onClick={() => activeGroupId != null && selectTerminalTab(activeGroupId, tab.id)}
              onDragStart={(e) => {
                if (activeGroupId == null) return;
                setDrag({ kind: "tab", groupId: activeGroupId, id: tab.id });
                e.dataTransfer.setData("text/plain", termTabLabel(tab));
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => {
                clearDrag();
                setDragOverTab(null);
              }}
              onDragOver={(e) => {
                const d = getDrag();
                // Only same-group tab drags reorder; ignore repo/group/cross-group.
                if (d?.kind !== "tab" || d.groupId !== activeGroupId || d.id === tab.id) {
                  return;
                }
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOverTab({ id: tab.id, edge: tabEdgeFor(e) });
              }}
              onDragLeave={() => {
                setDragOverTab((cur) => (cur?.id === tab.id ? null : cur));
              }}
              onDrop={(e) => {
                const d = getDrag();
                if (
                  d?.kind === "tab" &&
                  d.groupId === activeGroupId &&
                  d.id !== tab.id &&
                  activeGroupId != null
                ) {
                  e.preventDefault();
                  reorderTerminalTab(
                    activeGroupId,
                    d.id,
                    tab.id,
                    tabEdgeFor(e) === "right" ? "after" : "before",
                  );
                }
                setDragOverTab(null);
                clearDrag();
              }}
              className={cn(
                "flex min-w-0 cursor-pointer items-center gap-1.5 border-r border-[var(--color-border)] px-3",
                tab.id === gt?.activeTabId
                  ? "bg-[var(--color-background)] text-[var(--color-foreground)]"
                  : "text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]",
                // Insertion line on the hovered edge — listed last so its colour
                // wins over the default right border.
                dragOverTab?.id === tab.id &&
                  dragOverTab.edge === "left" &&
                  "border-l-2 border-l-[var(--color-primary)]",
                dragOverTab?.id === tab.id &&
                  dragOverTab.edge === "right" &&
                  "border-r-2 border-r-[var(--color-primary)]",
              )}
            >
              {tabKind && <ActivityDot kind={tabKind} />}
              {editingTabId === tab.id ? (
                <input
                  autoFocus
                  value={draftTitle}
                  placeholder={tab.title}
                  aria-label={`Rename ${termTabLabel(tab)} terminal`}
                  // Terminal labels are arbitrary names, not prose — don't let
                  // the platform rewrite or flag them.
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitRename();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setEditingTabId(null);
                    }
                  }}
                  className="min-w-0 w-24 rounded border border-[var(--color-accent)] bg-[var(--color-background)] px-1 text-[var(--color-foreground)] outline-none"
                />
              ) : (
                <span
                  className="min-w-0 truncate"
                  title="Double-click to rename"
                  onDoubleClick={() => beginRename(tab)}
                >
                  {termTabLabel(tab)}
                </span>
              )}
              {tab.panes.length > 1 && (
                <span className="shrink-0 text-[10px] text-[var(--color-muted-foreground)]">
                  ×{tab.panes.length}
                </span>
              )}
              <button
                aria-label={`Close ${termTabLabel(tab)} terminal`}
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseTab(tab.id);
                }}
                className="ml-0.5 flex size-4 shrink-0 items-center justify-center rounded hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}

        <div className="ml-auto flex items-center gap-0.5 pr-1 pl-1">
          {activeDead && (
            <button
              title="Restart shell"
              onClick={() => activeTab && restart(activeTab.activePaneId)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
            >
              <RotateCw className="size-3.5" />
              Restart
            </button>
          )}
          <button
            title="Split terminal (⌘D)"
            aria-label="Split terminal"
            disabled={!activeTab}
            onClick={handleSplit}
            className="flex size-6 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)] disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <SplitSquareHorizontal className="size-4" />
          </button>
          <button
            title="New terminal (⌘T)"
            aria-label="New terminal"
            disabled={!canNewTab}
            onClick={handleNewTab}
            className="flex size-6 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)] disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Plus className="size-4" />
          </button>
          <button
            title={terminalMaximized ? "Restore terminal (⌘⇧`)" : "Maximize terminal (⌘⇧`)"}
            aria-label={terminalMaximized ? "Restore terminal" : "Maximize terminal"}
            aria-pressed={terminalMaximized}
            onClick={toggleTerminalMaximized}
            className="flex size-6 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
          >
            {terminalMaximized ? (
              <Minimize2 className="size-4" />
            ) : (
              <Maximize2 className="size-4" />
            )}
          </button>
          <button
            title="Hide terminal (⌘`)"
            aria-label="Hide terminal"
            onClick={() => setTerminalOpen(false)}
            className="flex size-6 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {/* Viewport. Pane nodes are appended/positioned imperatively into the
          host; the overlay carries React-managed per-split close buttons. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={hostRef} className="pointer-events-none absolute inset-1.5" />
        {/* Per-split close buttons (only when the active tab is split). */}
        {n > 1 &&
          activePanes.map((pane, i) => (
            <button
              key={pane.id}
              title="Close split"
              aria-label="Close split"
              onClick={() => handleClosePane(pane.id)}
              style={{ left: `calc(${((i + 1) * 100) / n}% - 1.5rem)`, top: "0.25rem" }}
              className="absolute z-10 flex size-5 items-center justify-center rounded bg-[var(--color-sidebar)]/80 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            >
              <X className="size-3.5" />
            </button>
          ))}
        {/* Per-split activity markers: which split changed while you were away.
            The focused pane is cleared, so this only marks the others. */}
        {n > 1 &&
          activePanes.map((pane, i) => {
            const kind = termActivity[pane.id];
            // Guard the focused pane explicitly: the clear effect runs after
            // paint, so without this it could flash a dot for one frame.
            if (!kind || pane.id === activeTab?.activePaneId) return null;
            return (
              <span
                key={`act-${pane.id}`}
                title="Unseen activity in this pane"
                style={{ left: `calc(${(i * 100) / n}% + 0.5rem)`, top: "0.5rem" }}
                className="absolute z-10"
              >
                <ActivityDot kind={kind} />
              </span>
            );
          })}
        {tabs.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-xs text-[var(--color-muted-foreground)]">
            <span>No terminals open in this group.</span>
            <button
              disabled={!canNewTab}
              onClick={handleNewTab}
              className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[var(--color-foreground)] hover:bg-[var(--color-accent)] disabled:opacity-40"
            >
              <Plus className="size-3.5" />
              New terminal
            </button>
            {!canNewTab && <span>Add a repository or bind a folder to this group first.</span>}
          </div>
        )}
      </div>
    </div>
  );
}
