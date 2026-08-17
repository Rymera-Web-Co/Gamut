import { useEffect, useRef, type RefObject } from "react";

import type { GroupTerminals, SplitDirection, TermTab } from "@/store/ui";

/** State + actions the terminal keyboard shortcuts operate on. */
export interface TerminalShortcutContext {
  handleNewTab: () => void;
  handleSplit: (direction: SplitDirection) => void;
  handleCloseTab: (tabId: string) => void;
  selectTerminalTab: (groupId: number, tabId: string) => void;
  activeGroupId: number | null;
  gt: GroupTerminals | undefined;
  activeTab: TermTab | undefined;
}

/**
 * Terminal keyboard shortcuts, extracted from TerminalPane (#143). Handled here
 * (not in the global hook) because closing a tab must also kill its panes' PTYs,
 * which only the pane component can do.
 *
 *   ⌘T new tab (opens the pane if hidden)   ⌘W close active tab
 *   ⌘⇧] / ⌘⇧[ next / prev tab   Ctrl+Tab / Ctrl+⇧+Tab cycle tabs
 *   ⌘⌥1–9 jump to tab (9 = last)   ⌘D split right   ⌘⇧D split down
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
      // Ctrl+Tab / Ctrl+⇧+Tab cycle terminal tabs while the terminal is focused
      // (#156). Control-only on every platform, matching the repo-cycle binding
      // it shadows here — the global repo-cycle is suppressed while .xterm has
      // focus, so the two never fight. Only rotates with ≥2 tabs.
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === "Tab") {
        if (tabs.length > 1 && s.gt?.activeTabId) {
          e.preventDefault();
          const i = tabs.findIndex((t) => t.id === s.gt!.activeTabId);
          const dir = e.shiftKey ? -1 : 1;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
