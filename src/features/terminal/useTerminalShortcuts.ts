import { useEffect, useRef, type RefObject } from "react";

import { isMac } from "@/lib/shortcuts";
import type { SplitDirection, TermTab, Terminals } from "@/store/ui";

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

/**
 * The close-active-tab chord (#338) — ⌘W on macOS, Ctrl+⇧+W elsewhere, matched
 * on the physical `code` like every other terminal chord. Shared with the xterm
 * custom key handler, which must return false for it: xterm would otherwise
 * claim the chord and stop propagation, so the window listener would never see
 * it (the same trap `isTabCycleChord` documents, #323).
 *
 * Both halves of the platform split are deliberate, because the chord is no
 * longer scoped to the terminal pane:
 *
 *   - Off macOS the chord takes ⇧ so that plain Ctrl+W stays the shell's
 *     delete-previous-word (readline `unix-word-rubout`) — a key people use
 *     constantly while typing commands. Nothing was broken there to begin with:
 *     only macOS gets a native menu, so only macOS ever had ⌘W close the
 *     window.
 *   - On macOS the chord is ⌘W alone, and Ctrl+W no longer closes a tab. The
 *     old `metaKey || ctrlKey` match accepted it; now it goes back to the shell
 *     there too.
 *
 * `mac` is injectable so tests can drive both platforms.
 */
export function isCloseTabChord(e: KeyboardEvent, mac = isMac()): boolean {
  if (e.type !== "keydown" || e.code !== "KeyW" || e.altKey) return false;
  return mac ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.metaKey;
}

/** State + actions the terminal keyboard shortcuts operate on. */
export interface TerminalShortcutContext {
  handleNewTab: () => void;
  handleSplit: (direction: SplitDirection) => void;
  handleCloseTab: (tabId: string) => void;
  selectTerminalTab: (tabId: string) => void;
  /**
   * Switch tab + pane and re-focus the xterm. The cycle chord needs both, not
   * just a tab selection (#328).
   */
  focusTerminal: (tabId: string, paneId: string) => void;
  activeTab: TermTab | undefined;
  /**
   * Whether the terminal view is on screen. The pane stays mounted and
   * CSS-hidden when it is toggled away, so ⌘W — which fires app-wide — would
   * otherwise close a tab the user cannot see (#338).
   */
  terminalOpen: boolean;
  /** The whole terminal list — the ring the cycle chord walks, in rail order. */
  terminals: Terminals;
}

/**
 * The tab `dir` steps away from the current position in the ring, wrapping past
 * both ends — so the last tab steps back to the very first. The ring is the
 * terminal list in rail order, which the user arranges by hand (#340).
 *
 * A position that is not in the ring enters it instead of no-opping (#339) —
 * at the first tab going forward, the last tab going back, so the first press
 * moves the way the user asked. `fromTabId` is null before anything has been
 * focused; without this the chord would dead-end permanently. Null only when
 * there is genuinely nothing to step to: an empty ring, or a single tab that is
 * already the current position.
 */
export function stepTerminalTab(
  ring: TermTab[],
  fromTabId: string | null | undefined,
  dir: 1 | -1,
): TermTab | null {
  if (ring.length === 0) return null;
  const i = ring.findIndex((t) => t.id === fromTabId);
  // No current position — nothing has been focused yet (#339). Enter the ring
  // from the end the step is heading away from, so the first press moves in the
  // direction the user asked for instead of always walking forward. Without
  // this the chord dead-ends: the old `null` return made Ctrl+Tab a permanent
  // no-op in that state.
  if (i < 0) return dir === 1 ? ring[0] : ring[ring.length - 1];
  if (ring.length < 2) return null;
  return ring[(i + dir + ring.length) % ring.length];
}

/**
 * Terminal keyboard shortcuts, extracted from TerminalPane (#143). Handled here
 * (not in the global hook) because closing a tab must also kill its panes' PTYs,
 * which only the pane component can do.
 *
 *   ⌘T new tab (opens the pane if hidden)   ⌘W / Ctrl+⇧+W close active tab
 *   ⌘⇧] / ⌘⇧[ next / prev terminal   Ctrl+Tab / Ctrl+⇧+Tab cycle terminals
 *   ⌘⌥1–9 jump to tab (9 = last)   ⌘D split right   ⌘⇧D split down
 *
 * The terminal list is one flat sequence in rail order (#340), so next/prev,
 * Ctrl+Tab and ⌘⌥1–9 all walk the same list — none of them is group-scoped.
 *
 * Everything but ⌘T and ⌘W is scoped to the terminal pane (`hostRef`) having
 * focus, so it never steals keys from the editor (e.g. Monaco's own ⌘D). Those
 * two are app-wide on purpose: ⌘W must beat the native "Close Window"
 * accelerator from every focus location (#338). The live context is read
 * through a ref so the listener is registered once.
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
      // ⌘W closes the active terminal tab from anywhere — deliberately outside
      // the focus gate below (#338). Gated, it only ran while a terminal pane
      // held focus; with focus in the sidebar, review pane, file tree or editor
      // the key fell through to the native "Close Window" accelerator and took
      // the whole window — every live terminal session — with it.
      //
      // The key is ALWAYS swallowed — with the terminal hidden, with no tab to
      // close, on every platform — because that is what keeps the accelerator
      // from firing; ⌘Q stays the way to quit. What varies is only whether a
      // tab closes:
      //   - the terminal view must be on screen. The pane stays mounted and
      //     CSS-hidden when toggled away, so without this a press while reading
      //     a diff would kill a session off-screen, with nothing to see.
      //   - `repeat` events never close, so holding the chord closes one tab
      //     rather than a burst (the close is async, so every repeat would
      //     still read the same `activeTab`).
      //
      // This deliberately bypasses the `isTypingTarget` convention the global
      // shortcuts follow: the chord must win over the native accelerator from
      // every focus location, text fields included.
      if (isCloseTabChord(e)) {
        e.preventDefault();
        if (!e.repeat && s.terminalOpen && s.activeTab) s.handleCloseTab(s.activeTab.id);
        return;
      }
      // The rest act on the focused terminal pane only.
      const focused = hostRef.current?.contains(document.activeElement) ?? false;
      if (!focused) return;
      const tabs = s.terminals.tabs;
      // The next/prev-terminal step both bindings below share: one ring over
      // the whole terminal list (#328).
      const step = (dir: 1 | -1) => stepTerminalTab(tabs, s.terminals.activeTabId, dir);
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
      // ⌘⇧] / ⌘⇧[ = next / prev terminal. Walks the same ring as Ctrl+Tab
      // below (#328) so the two bindings share one mental model.
      if (e.shiftKey && !e.altKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
        const next = step(e.code === "BracketRight" ? 1 : -1);
        if (next) {
          e.preventDefault();
          s.focusTerminal(next.id, next.activePaneId);
        }
        return;
      }
      // Ctrl+Tab / Ctrl+⇧+Tab cycle terminal tabs while the terminal is focused
      // (#156). Control-only on every platform, matching the repo-cycle binding
      // it shadows here — the global repo-cycle is suppressed while .xterm has
      // focus, so the two never fight. The ring is the whole terminal list
      // (#328, #340). Only rotates with ≥2 terminals.
      if (isTabCycleChord(e)) {
        // Always swallow the chord while the terminal is focused (same rule as
        // ⌘W above): xterm no longer handles it, so an un-prevented event
        // would fall through to the webview's own Tab handling — focus
        // traversal on WebKitGTK. No-op with <2 terminals.
        e.preventDefault();
        const next = step(e.shiftKey ? -1 : 1);
        // focusTerminal, not selectTerminalTab: the step may land in another
        // group, which must become active and take keyboard focus.
        if (next) s.focusTerminal(next.id, next.activePaneId);
        return;
      }
      // ⌘⌥1–9 jumps by index into the terminal list, in rail order (9 = last).
      if (e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        const n = Number(e.code.slice(5));
        const idx = n === 9 ? tabs.length - 1 : n - 1;
        if (tabs[idx]) {
          e.preventDefault();
          s.selectTerminalTab(tabs[idx].id);
        }
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
