import { useRef } from "react";
import { Plus, RotateCw, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

import { useGroups, useRepos } from "@/features/repos/api";
import { visibleRepos } from "@/lib/groupRepos";
import { useSettings } from "@/lib/settings";
import { useTheme } from "@/lib/theme";
import { useUiStore, type SplitDirection } from "@/store/ui";
import { ActivityDot } from "./activity";
import { paneSlots, resizePair } from "./paneLayout";
import { xtermTheme } from "./terminalTheme";
import { useTerminalSessions } from "./useTerminalSessions";
import { useTerminalShortcuts } from "./useTerminalShortcuts";

// No divider may shrink a pane below this share of its axis' total weight.
const MIN_SHARE = 0.08;

/**
 * The integrated terminal pane: a per-group set of tabs, each holding a grid
 * of split panes — rows of side-by-side panes, any mix (#316) — with
 * drag-to-resize dividers between panes and between rows. The live xterm
 * instances, their layout/spawn and theme/resize coordination live in
 * {@link useTerminalSessions}; the keyboard shortcuts are
 * {@link useTerminalShortcuts}. The sidebar's terminal rail is the tab list,
 * and the header above carries the session controls — this component renders
 * the viewport host the sessions mount into (#143).
 */
export function TerminalPane() {
  const terminalOpen = useUiStore((s) => s.terminalOpen);
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  const activeWorktreePath = useUiStore((s) => s.activeWorktreePath);
  const terminals = useUiStore((s) => s.terminals);
  const addTerminalTab = useUiStore((s) => s.addTerminalTab);
  const splitTerminal = useUiStore((s) => s.splitTerminal);
  const selectTerminalTab = useUiStore((s) => s.selectTerminalTab);
  const focusTerminal = useUiStore((s) => s.focusTerminal);
  const setActivePane = useUiStore((s) => s.setActivePane);
  const closeTerminalTab = useUiStore((s) => s.closeTerminalTab);
  const closeTerminalPane = useUiStore((s) => s.closeTerminalPane);
  const termActivity = useUiStore((s) => s.termActivity);
  const markTermActivity = useUiStore((s) => s.markTermActivity);
  const clearTermActivity = useUiStore((s) => s.clearTermActivity);
  const terminalFocusNonce = useUiStore((s) => s.terminalFocusNonce);
  const newTabDir = useSettings((s) => s.values.terminalNewTabDir);
  const theme = useTheme((s) => s.theme);

  const repos = useRepos();
  const groups = useGroups();
  const repoList = repos.data ?? [];
  const groupList = groups.data ?? [];

  const hostRef = useRef<HTMLDivElement>(null);

  const resizeTerminalSplit = useUiStore((s) => s.resizeTerminalSplit);

  const gt = activeGroupId != null ? terminals[activeGroupId] : undefined;
  const activeTab = gt?.tabs.find((t) => t.id === gt.activeTabId);
  const activePanes = activeTab?.panes ?? [];
  // Stable dep so the layout effect re-runs on tab/grid changes — rows, and
  // the width/height weights a divider drag rebalances (#316). Weights are
  // rounded so float noise can't churn the key.
  const paneKey = `${activeGroupId}|${activeTab?.id ?? ""}|${(activeTab?.rowSizes ?? [])
    .map((w) => w.toFixed(3))
    .join(":")}|${activePanes
    .map((p) => `${p.id}@${p.row ?? 0}x${(p.size ?? 1).toFixed(3)}`)
    .join(",")}`;

  // The one pane the user is actually looking at: the focused pane of the
  // active tab while the panel is open.
  const visiblePaneId = terminalOpen && activeTab ? activeTab.activePaneId : null;

  const { deadKeys, killPane, restart } = useTerminalSessions({
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
  });

  // The cwd/title a brand-new tab should default to. The repo selected in the
  // active group always wins (an explicit per-action intent); when none is
  // selected, the `terminalNewTabDir` setting picks the fallback — the group's
  // bound folder or the first repo shown in the group — each with the other as a
  // secondary fallback so a folderless group or a repoless group still resolves.
  function defaultTarget(): { cwd: string; title: string } | null {
    const group = groupList.find((g) => g.id === activeGroupId);
    const visible = visibleRepos(repoList, group);
    const selected = visible.find((r) => r.id === activeRepoId && !r.missing);
    if (selected) {
      // A selected linked worktree of the repo wins over its main checkout.
      if (activeWorktreePath) {
        const base = activeWorktreePath.split("/").filter(Boolean).pop() ?? selected.name;
        return { cwd: activeWorktreePath, title: `${selected.name} (${base})` };
      }
      return { cwd: selected.path, title: selected.name };
    }

    const groupFolder = group?.folder_path ? { cwd: group.folder_path, title: group.name } : null;
    const firstRepo = (() => {
      const r = visible.find((repo) => !repo.missing);
      return r ? { cwd: r.path, title: r.name } : null;
    })();

    return newTabDir === "group" ? (groupFolder ?? firstRepo) : (firstRepo ?? groupFolder);
  }

  function handleNewTab() {
    const target = defaultTarget();
    if (target && activeGroupId != null) {
      addTerminalTab(activeGroupId, target.cwd, target.title);
    }
  }

  function handleSplit(splitDirection: SplitDirection) {
    if (activeGroupId == null || !activeTab) return;
    const active =
      activeTab.panes.find((p) => p.id === activeTab.activePaneId) ?? activeTab.panes[0];
    splitTerminal(activeGroupId, active.cwd, splitDirection);
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

  useTerminalShortcuts(hostRef, {
    handleNewTab,
    handleSplit,
    handleCloseTab,
    selectTerminalTab,
    focusTerminal,
    activeGroupId,
    gt,
    activeTab,
    // The cycle chord walks every group's terminals in sidebar order (#328),
    // so it needs the group order and the whole terminals map, not just `gt`.
    groupOrder: groupList.map((g) => g.id),
    terminals,
  });

  const tabs = gt?.tabs ?? [];
  const canNewTab = defaultTarget() != null;
  const n = activePanes.length;
  const activeDead = activeTab != null && deadKeys.has(activeTab.activePaneId);
  const slots = paneSlots(activePanes, activeTab?.rowSizes);

  // ── Divider drag-to-resize (#316) ────────────────────────────────────────
  // A vertical divider rebalances the width weights of the two panes it sits
  // between; a horizontal divider rebalances the height weights of the two
  // rows (the math is paneLayout's `resizePair`). Weights live in the store,
  // so the layout effect re-fits the xterms as the drag moves — throttled to
  // one commit per animation frame, because every commit also persists the
  // layout and re-runs the whole layout pass (a raw pointermove stream would
  // thrash localStorage, the resize IPC, and full-screen TUIs with SIGWINCH).
  // Pointer capture keeps the drag alive off the 6px handle.
  const dragRef = useRef<
    | {
        kind: "pane";
        leftId: string;
        rightId: string;
        startLeft: number;
        startRight: number;
        rowTotal: number;
        hostWidthPx: number;
        startX: number;
      }
    | {
        kind: "row";
        pos: number;
        startRowSizes: number[];
        hostHeightPx: number;
        startY: number;
      }
    | null
  >(null);
  const commitRaf = useRef(0);
  const pendingCommit = useRef<{ paneSizes?: Record<string, number>; rowSizes?: number[] } | null>(
    null,
  );

  function scheduleCommit(patch: { paneSizes?: Record<string, number>; rowSizes?: number[] }) {
    pendingCommit.current = patch;
    if (commitRaf.current) return;
    commitRaf.current = requestAnimationFrame(() => {
      commitRaf.current = 0;
      const pending = pendingCommit.current;
      pendingCommit.current = null;
      if (pending && activeGroupId != null && activeTab) {
        resizeTerminalSplit(activeGroupId, activeTab.id, pending);
      }
    });
  }

  function beginPaneDrag(e: React.PointerEvent<HTMLElement>, i: number) {
    const host = hostRef.current;
    if (!host || i < 1) {
      dragRef.current = null;
      return;
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Full-window cursor while dragging: the pointer leaves the 6px handle
    // long before the drag ends (same trick as the sidebar splitter).
    document.body.style.cursor = "col-resize";
    const row = activePanes[i].row ?? 0;
    const rowTotal = activePanes
      .filter((p) => (p.row ?? 0) === row)
      .reduce((a, p) => a + (p.size ?? 1), 0);
    dragRef.current = {
      kind: "pane",
      // Row-major order: the previous array entry is this pane's left neighbour.
      leftId: activePanes[i - 1].id,
      rightId: activePanes[i].id,
      startLeft: activePanes[i - 1].size ?? 1,
      startRight: activePanes[i].size ?? 1,
      rowTotal,
      hostWidthPx: host.getBoundingClientRect().width,
      startX: e.clientX,
    };
  }

  function beginRowDrag(e: React.PointerEvent<HTMLElement>, pos: number) {
    const host = hostRef.current;
    if (!host || !activeTab || pos < 1) {
      dragRef.current = null;
      return;
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = "row-resize";
    const rowCount = new Set(activePanes.map((p) => p.row ?? 0)).size;
    const startRowSizes = Array.from({ length: rowCount }, (_, i) => activeTab.rowSizes?.[i] ?? 1);
    dragRef.current = {
      kind: "row",
      pos,
      startRowSizes,
      hostHeightPx: host.getBoundingClientRect().height,
      startY: e.clientY,
    };
  }

  function onDividerMove(e: React.PointerEvent<HTMLElement>) {
    const d = dragRef.current;
    if (!d || activeGroupId == null || !activeTab) return;
    if (d.kind === "pane") {
      const [left, right] = resizePair(
        d.startLeft,
        d.startRight,
        d.rowTotal,
        e.clientX - d.startX,
        d.hostWidthPx,
        MIN_SHARE,
      );
      scheduleCommit({ paneSizes: { [d.leftId]: left, [d.rightId]: right } });
    } else {
      const total = d.startRowSizes.reduce((a, b) => a + b, 0);
      const [above, below] = resizePair(
        d.startRowSizes[d.pos - 1],
        d.startRowSizes[d.pos],
        total,
        e.clientY - d.startY,
        d.hostHeightPx,
        MIN_SHARE,
      );
      const rowSizes = [...d.startRowSizes];
      rowSizes[d.pos - 1] = above;
      rowSizes[d.pos] = below;
      scheduleCommit({ rowSizes });
    }
  }

  function endDividerDrag() {
    // Flush the last pending frame so the release position always lands.
    if (commitRaf.current) {
      cancelAnimationFrame(commitRaf.current);
      commitRaf.current = 0;
    }
    const pending = pendingCommit.current;
    pendingCommit.current = null;
    if (pending && activeGroupId != null && activeTab) {
      resizeTerminalSplit(activeGroupId, activeTab.id, pending);
    }
    document.body.style.cursor = "";
    dragRef.current = null;
  }

  // Keyboard resize on a focused divider (#316): arrows nudge the pair by a
  // fixed share of the axis, Home resets the pair to an equal split — the
  // same ARIA-separator contract the sidebar splitter implements.
  const NUDGE_PX = 100;
  function nudgePane(i: number, dir: -1 | 1 | 0) {
    if (activeGroupId == null || !activeTab || i < 1) return;
    const row = activePanes[i].row ?? 0;
    const rowTotal = activePanes
      .filter((p) => (p.row ?? 0) === row)
      .reduce((a, p) => a + (p.size ?? 1), 0);
    const a = activePanes[i - 1].size ?? 1;
    const b = activePanes[i].size ?? 1;
    const [left, right] =
      dir === 0
        ? [(a + b) / 2, (a + b) / 2]
        : resizePair(a, b, rowTotal, dir * NUDGE_PX, hostRef.current?.clientWidth || 1, MIN_SHARE);
    resizeTerminalSplit(activeGroupId, activeTab.id, {
      paneSizes: { [activePanes[i - 1].id]: left, [activePanes[i].id]: right },
    });
  }
  function nudgeRow(pos: number, dir: -1 | 1 | 0) {
    if (activeGroupId == null || !activeTab || pos < 1) return;
    const rowCount = new Set(activePanes.map((p) => p.row ?? 0)).size;
    const rowSizes = Array.from({ length: rowCount }, (_, i) => activeTab.rowSizes?.[i] ?? 1);
    const total = rowSizes.reduce((a, b) => a + b, 0);
    const pair = rowSizes[pos - 1] + rowSizes[pos];
    const [above, below] =
      dir === 0
        ? [pair / 2, pair / 2]
        : resizePair(
            rowSizes[pos - 1],
            rowSizes[pos],
            total,
            dir * NUDGE_PX,
            hostRef.current?.clientHeight || 1,
            MIN_SHARE,
          );
    rowSizes[pos - 1] = above;
    rowSizes[pos] = below;
    resizeTerminalSplit(activeGroupId, activeTab.id, { rowSizes });
  }

  // Horizontal (between-rows) divider positions: the top edge of each row
  // after the first — read off the first slot of that row.
  const rowBoundaries = slots.filter((s) => s.firstInRow && !s.firstRow);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{ background: xtermTheme(theme).background }}
    >
      {/* Viewport. Pane nodes are appended/positioned imperatively into the
          host; the overlay carries React-managed per-split close buttons.
          There is no tab strip — the sidebar's terminal rail is the tab list;
          split/new/close stay reachable via the header and shortcuts. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={hostRef} className="pointer-events-none absolute inset-1.5" />
        {/* The active shell exited — offer a restart where the strip's
            Restart button used to live. */}
        {activeDead && activeTab && (
          <button
            onClick={() => restart(activeTab.activePaneId)}
            className="absolute right-3 top-2 z-10 flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2.5 py-1 text-xs font-medium text-[var(--color-secondary-foreground)] hover:text-[var(--color-foreground)]"
          >
            <RotateCw className="size-3.5" />
            Restart shell
          </button>
        )}
        {/* Per-split close buttons (only when the active tab is split), pinned
            to each pane's top-right corner on the grid (#316). */}
        {n > 1 &&
          activePanes.map((pane, i) => (
            <button
              key={pane.id}
              title="Close split"
              aria-label="Close split"
              onClick={() => handleClosePane(pane.id)}
              style={{
                left: `calc(${slots[i].left + slots[i].width}% - 1.5rem)`,
                top: `calc(${slots[i].top}% + 0.25rem)`,
              }}
              className="absolute z-10 flex size-5 items-center justify-center rounded bg-[var(--color-sidebar)]/80 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            >
              <X className="size-3.5" />
            </button>
          ))}
        {/* Per-split activity markers: which split changed while you were away.
            The focused pane is cleared, so this only marks the others. Pinned
            to each pane's top-left corner on the grid (#316). */}
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
                style={{
                  left: `calc(${slots[i].left}% + 0.5rem)`,
                  top: `calc(${slots[i].top}% + 0.5rem)`,
                }}
                className="absolute z-10"
              >
                <ActivityDot kind={kind} />
              </span>
            );
          })}
        {/* Drag handles on the split boundaries (#316): a vertical handle on
            each pane's left edge (within its row), a horizontal handle on each
            row's top edge. Each rebalances just the two neighbours it sits
            between; the layout effect re-fits the xterms as the drag moves.
            They live in a wrapper matching the pane host's inset so the
            handles sit exactly on the seams they resize; the wrapper is
            pointer-events-none (like the host) and each handle re-enables
            events. Keyboard: arrows nudge, Home resets the pair to equal —
            the same ARIA-separator contract as the sidebar splitter. */}
        <div className="pointer-events-none absolute inset-1.5">
          {slots.map((slot, i) =>
            slot.firstInRow ? null : (
              <div
                key={`vdiv-${activePanes[i].id}`}
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label={`Resize split columns (row ${slot.rowPos + 1})`}
                aria-valuemin={Math.round(MIN_SHARE * 100)}
                aria-valuemax={100 - Math.round(MIN_SHARE * 100)}
                aria-valuenow={Math.round(slots[i - 1].width)}
                onPointerDown={(e) => beginPaneDrag(e, i)}
                onPointerMove={onDividerMove}
                onPointerUp={endDividerDrag}
                onPointerCancel={endDividerDrag}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft") nudgePane(i, -1);
                  else if (e.key === "ArrowRight") nudgePane(i, 1);
                  else if (e.key === "Home") nudgePane(i, 0);
                  else return;
                  e.preventDefault();
                }}
                style={{
                  left: `calc(${slot.left}% - 3px)`,
                  top: `${slot.top}%`,
                  height: `${slot.height}%`,
                }}
                className="pointer-events-auto absolute z-10 w-1.5 cursor-col-resize transition-colors hover:bg-[var(--color-primary)]/30 focus-visible:bg-[var(--color-primary)]/40 focus-visible:outline-none active:bg-[var(--color-primary)]/50"
              />
            ),
          )}
          {rowBoundaries.map((slot) => (
            <div
              key={`hdiv-${slot.rowPos}`}
              role="separator"
              tabIndex={0}
              aria-orientation="horizontal"
              aria-label={`Resize split rows (${slot.rowPos}/${slot.rowPos + 1})`}
              aria-valuemin={Math.round(MIN_SHARE * 100)}
              aria-valuemax={100 - Math.round(MIN_SHARE * 100)}
              aria-valuenow={Math.round(slot.top)}
              onPointerDown={(e) => beginRowDrag(e, slot.rowPos)}
              onPointerMove={onDividerMove}
              onPointerUp={endDividerDrag}
              onPointerCancel={endDividerDrag}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp") nudgeRow(slot.rowPos, -1);
                else if (e.key === "ArrowDown") nudgeRow(slot.rowPos, 1);
                else if (e.key === "Home") nudgeRow(slot.rowPos, 0);
                else return;
                e.preventDefault();
              }}
              style={{ top: `calc(${slot.top}% - 3px)` }}
              className="pointer-events-auto absolute inset-x-0 z-10 h-1.5 cursor-row-resize transition-colors hover:bg-[var(--color-primary)]/30 focus-visible:bg-[var(--color-primary)]/40 focus-visible:outline-none active:bg-[var(--color-primary)]/50"
            />
          ))}
        </div>
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
