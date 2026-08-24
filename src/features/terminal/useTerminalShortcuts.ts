import { useEffect, useRef, type RefObject } from "react";

import type { GroupTerminals, SplitDirection, TermTab } from "@/store/ui";

/**
 * The Ctrl+Tab / Ctrl+⇧+Tab tab-cycle chord (#156), physical-`code` matched
 * like every other terminal chord. Shared with the xterm custom key handler,
 * which must return false for it: xterm would otherwise map Tab to `\t` (typed
 * into the shell) and stop propagation, so the window listener below would
 * never see the chord (#323). Keydown-only — xterm consults the handler for
 * keyup/keypress too, and those must keep their default handling.
 */
export function isTabCycleChord(e: KeyboardEvent): boolean {
  return e.type === "keydown" && e.ctrlKey && !e.metaKey && !e.altKey && e.code === "Tab";
}

/** State + actions the terminal keyboard shortcuts operate on. */
export interface TerminalShortcutContext {
  handleNewTab: () => void;
  handleSplit: (direction: SplitDirection) => void;
  handleCloseTab: (tabId: string) => void;
  selectTerminalTab: (groupId: number, tabId: string) => void;
  /**
   * Switch group + tab + pane and re-focus the xterm. The cross-group cycle
   * chord needs all of that, not just a tab selection (#328).
   */
  focusTerminal: (groupId: number, tabId: string, paneId: string) => void;
  activeGroupId: number | null;
  gt: GroupTerminals | undefined;
  activeTab: TermTab | undefined;
  /** Every group's id in sidebar order — the order the cycle chord walks. */
  groupOrder: number[];
  /** Every group's terminals, so the chord can reach tabs outside the active group. */
  terminals: Record<number, GroupTerminals>;
}

/** One terminal tab, paired with the group that owns it. */
export interface GroupTab {
  groupId: number;
  tab: TermTab;
}

/**
 * Every terminal tab in every group, flattened into one ring: groups in
 * sidebar order (`groupOrder`), tabs in tab-strip order within a group. Groups
 * with no terminals — and stale `terminals` entries for groups that no longer
 * exist — drop out. This is the ring the Ctrl+Tab chord walks (#328).
 */
export function flattenTerminalTabs(
  groupOrder: number[],
  terminals: Record<number, GroupTerminals>,
): GroupTab[] {
  const ring: GroupTab[] = [];
  for (const groupId of groupOrder) {
    for (const tab of terminals[groupId]?.tabs ?? []) ring.push({ groupId, tab });
  }
  return ring;
}

/**
 * The tab `dir` steps away from the active one in the ring, wrapping past both
 * ends — so the last tab of a group steps into the first tab of the next group,
 * and the very last tab wraps back to the very first. Null when the ring holds
 * fewer than two tabs, or the active tab is not in it (nothing to step from).
 */
export function stepTerminalTab(
  ring: GroupTab[],
  activeGroupId: number | null,
  activeTabId: string | null | undefined,
  dir: 1 | -1,
): GroupTab | null {
  if (ring.length < 2) return null;
  const i = ring.findIndex((e) => e.groupId === activeGroupId && e.tab.id === activeTabId);
  if (i < 0) return null;
  return ring[(i + dir + ring.length) % ring.length];
}

/**
 * Terminal keyboard shortcuts, extracted from TerminalPane (#143). Handled here
 * (not in the global hook) because closing a tab must also kill its panes' PTYs,
 * which only the pane component can do.
 *
 *   ⌘T new tab (opens the pane if hidden)   ⌘W close active tab
 *   ⌘⇧] / ⌘⇧[ next / prev terminal   Ctrl+Tab / Ctrl+⇧+Tab cycle terminals
 *   ⌘⌥1–9 jump to tab (9 = last)   ⌘D split right   ⌘⇧D split down
 *
 * The two next/prev bindings walk every terminal in every group (#328) and
 * switch group when they step out of the active one; ⌘⌥1–9 stays an index into
 * the active group's own tab strip.
 *
 * Everything but ⌘T is scoped to the terminal pane (`hostRef`) having focus, so
 * it never steals keys from the editor (e.g. Monaco's own ⌘D). The live context
 * is read through a ref so the listener is registered once.
 */
export function useTerminalShortcuts(
  hostRef: RefObject<HTMLDivElement | null>,
  ctx: TerminalShortcutContext,
) {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const s = ctxRef.current;
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
      // The next/prev-terminal step both bindings below share: one ring of
      // every terminal in every group (#328).
      const step = (dir: 1 | -1) =>
        stepTerminalTab(
          flattenTerminalTabs(s.groupOrder, s.terminals),
          s.activeGroupId,
          s.gt?.activeTabId,
          dir,
        );
      if (!e.altKey && !e.shiftKey && e.code === "KeyW") {
        // Always swallow ⌘W while the terminal is focused so it can't fall
        // through to closing the Tauri window; no-op when there's no tab.
        e.preventDefault();
        if (s.activeTab) s.handleCloseTab(s.activeTab.id);
        return;
      }
      if (!e.altKey && !e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        s.handleSplit("row");
        return;
      }
      // ⌘⇧D = split down (stacked panes, #316).
      if (!e.altKey && e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        s.handleSplit("column");
        return;
      }
      // ⌘⇧] / ⌘⇧[ = next / prev terminal. Walks the same every-group ring as
      // Ctrl+Tab below (#328) so the two bindings share one mental model.
      if (e.shiftKey && !e.altKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
        const next = step(e.code === "BracketRight" ? 1 : -1);
        if (next) {
          e.preventDefault();
          s.focusTerminal(next.groupId, next.tab.id, next.tab.activePaneId);
        }
        return;
      }
      // Ctrl+Tab / Ctrl+⇧+Tab cycle terminal tabs while the terminal is focused
      // (#156). Control-only on every platform, matching the repo-cycle binding
      // it shadows here — the global repo-cycle is suppressed while .xterm has
      // focus, so the two never fight. The ring spans *every* group, not just
      // the active one (#328), so it also switches group when it steps out of
      // the current one. Only rotates with ≥2 terminals.
      if (isTabCycleChord(e)) {
        // Always swallow the chord while the terminal is focused (same rule as
        // ⌘W above): xterm no longer handles it, so an un-prevented event
        // would fall through to the webview's own Tab handling — focus
        // traversal on WebKitGTK. No-op with <2 terminals.
        e.preventDefault();
        const next = step(e.shiftKey ? -1 : 1);
        // focusTerminal, not selectTerminalTab: the step may land in another
        // group, which must become active and take keyboard focus.
        if (next) s.focusTerminal(next.groupId, next.tab.id, next.tab.activePaneId);
        return;
      }
      // ⌘⌥1–9 jumps by index inside the *active group's* tab strip — the one
      // tab binding that deliberately stays group-scoped (#328).
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
