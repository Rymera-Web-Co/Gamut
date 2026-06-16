import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Plus, RotateCw, SplitSquareHorizontal, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { useGroups, useRepos } from "@/features/repos/api";
import { ipc } from "@/lib/ipc";
import { useSettings } from "@/lib/settings";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useUiStore, type TermPane } from "@/store/ui";

/** One live xterm instance + the DOM node it's mounted in, kept across switches. */
interface SessionEntry {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
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

/**
 * The integrated terminal pane: a per-group set of tabs, each with one or more
 * side-by-side split panes. Every pane is a long-lived xterm instance mounted
 * in an absolutely-positioned node and shown/hidden imperatively, so scrollback
 * and running processes survive tab, split and group switches; the matching
 * backend PTY keeps running until the pane is explicitly closed or the app exits.
 */
export function TerminalPane() {
  const terminalOpen = useUiStore((s) => s.terminalOpen);
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const terminals = useUiStore((s) => s.terminals);
  const setTerminalOpen = useUiStore((s) => s.setTerminalOpen);
  const addTerminalTab = useUiStore((s) => s.addTerminalTab);
  const splitTerminal = useUiStore((s) => s.splitTerminal);
  const selectTerminalTab = useUiStore((s) => s.selectTerminalTab);
  const setActivePane = useUiStore((s) => s.setActivePane);
  const closeTerminalTab = useUiStore((s) => s.closeTerminalTab);
  const closeTerminalPane = useUiStore((s) => s.closeTerminalPane);
  const theme = useTheme((s) => s.theme);

  const repos = useRepos();
  const groups = useGroups();
  const repoList = repos.data ?? [];
  const groupList = groups.data ?? [];

  const hostRef = useRef<HTMLDivElement>(null);
  const sessionsRef = useRef<Map<string, SessionEntry>>(new Map());
  const [deadKeys, setDeadKeys] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);

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
    term.open(el);
    term.onData((data) => {
      ipc.terminalWrite(pane.id, encoder.encode(data)).catch(() => {});
    });
    el.addEventListener("mousedown", () => {
      const { groupId, tabId } = ctxRef.current;
      if (groupId != null && tabId) setActivePane(groupId, tabId, pane.id);
    });
    const entry: SessionEntry = { term, fit, el, spawned: false };
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
            .terminalSpawn(pane.id, pane.cwd, e.term.cols, e.term.rows, (bytes) =>
              e.term.write(bytes),
            )
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalOpen, paneKey, tick]);

  // Re-theme all live sessions when the app theme toggles.
  useEffect(() => {
    const t = xtermTheme(theme);
    for (const entry of sessionsRef.current.values()) {
      entry.term.options.theme = t;
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

  // A shell exited: note it so the active pane can offer Restart.
  useEffect(() => {
    const unlisten = listen<string>("terminal-exit", (ev) => {
      const key = ev.payload;
      const e = sessionsRef.current.get(key);
      if (e) e.term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
      setDeadKeys((prev) => new Set(prev).add(key));
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, []);

  function disposeEntry(id: string) {
    const e = sessionsRef.current.get(id);
    if (e) {
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
    const inGroup = group?.is_default
      ? repoList.filter((r) => r.group_ids.length === 0 && !r.missing)
      : repoList.filter(
          (r) => activeGroupId != null && r.group_ids.includes(activeGroupId) && !r.missing,
        );
    const first = inGroup[0];
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

  const tabs = gt?.tabs ?? [];
  const canNewTab = defaultTarget() != null;
  const n = activePanes.length;
  const activeDead =
    activeTab != null && deadKeys.has(activeTab.activePaneId);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{ background: xtermTheme(theme).background }}
    >
      {/* Tab strip + controls. */}
      <div className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-sidebar)] text-xs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === gt?.activeTabId}
            onClick={() => activeGroupId != null && selectTerminalTab(activeGroupId, tab.id)}
            className={cn(
              "flex max-w-44 shrink-0 cursor-pointer items-center gap-1.5 border-r border-[var(--color-border)] px-3",
              tab.id === gt?.activeTabId
                ? "bg-[var(--color-background)] text-[var(--color-foreground)]"
                : "text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]",
            )}
          >
            <span className="min-w-0 truncate">{tab.title}</span>
            {tab.panes.length > 1 && (
              <span className="shrink-0 text-[10px] text-[var(--color-muted-foreground)]">
                ×{tab.panes.length}
              </span>
            )}
            <button
              aria-label={`Close ${tab.title} terminal`}
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
        ))}

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
            title="Split terminal"
            aria-label="Split terminal"
            disabled={!activeTab}
            onClick={handleSplit}
            className="flex size-6 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)] disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <SplitSquareHorizontal className="size-4" />
          </button>
          <button
            title="New terminal"
            aria-label="New terminal"
            disabled={!canNewTab}
            onClick={handleNewTab}
            className="flex size-6 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)] disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Plus className="size-4" />
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
            {!canNewTab && (
              <span>Add a repository or bind a folder to this group first.</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
