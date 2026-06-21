import { useEffect, useMemo, useRef } from "react";

import { useFetchGroup, useGroups, useRepos } from "@/features/repos/api";
import { useSyncActions } from "@/features/sync/useSyncActions";
import { ipc } from "@/lib/ipc";
import { useSettings } from "@/lib/settings";
import {
  matchesBinding,
  parseOverrides,
  resolveBindings,
  SHORTCUTS,
  type Binding,
  type ShortcutId,
} from "@/lib/shortcuts";
import { useTheme } from "@/lib/theme";
import { useUiStore } from "@/store/ui";

/**
 * Global keyboard shortcuts, dispatched from the user-configurable binding map
 * (see `lib/shortcuts.ts` for the command set and `Settings → Keyboard` for
 * remapping). Defaults:
 *   ⌘/Ctrl+1–9 → select the Nth group in the rail (cmux-style; issue #95)
 *   ⌃1–4 → Files / History / Review / Pull Requests
 *   ⌘/Ctrl+B repo sidebar   ⌘/Ctrl+⇧+F repo-wide search   ⌘/Ctrl+J theme
 *   ⌘/Ctrl+K command palette   ⌘/Ctrl+` terminal   ⌘/Ctrl+⇧+` maximize terminal
 *   ⌘/Ctrl+, settings   ⌘/Ctrl+⇧+K push   ⌘/Ctrl+⇧+P pull
 *   ⌘/Ctrl+⌥+F fetch group   ⌃Tab / ⌃⇧Tab cycle repos in the active group
 *
 * Per-file find/replace (⌘/Ctrl+F, ⌘/Ctrl+H) is handled in the Files view, and
 * terminal tab shortcuts (⌘T/⌘W/⌘D/⌘⇧[ ]/⌘⌥1–9) live in TerminalPane.
 *
 * Commands flagged `whenTyping: false` (git sync, repo cycling) are suppressed
 * while the user is typing in an input, the editor, or a terminal, so they don't
 * clash with editor bindings such as Monaco's ⌘⇧K (delete line).
 */
export function useKeyboardShortcuts() {
  const setView = useUiStore((s) => s.setView);
  const toggleRepoSidebar = useUiStore((s) => s.toggleRepoSidebar);
  const toggleTerminal = useUiStore((s) => s.toggleTerminal);
  const toggleTerminalMaximized = useUiStore((s) => s.toggleTerminalMaximized);
  const toggleSettings = useUiStore((s) => s.toggleSettings);
  const toggleCommandPalette = useUiStore((s) => s.toggleCommandPalette);
  const focusRepoSearch = useUiStore((s) => s.focusRepoSearch);
  const setActiveRepo = useUiStore((s) => s.setActiveRepo);
  const setActiveGroup = useUiStore((s) => s.setActiveGroup);
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const toggleTheme = useTheme((s) => s.toggle);

  const repos = useRepos();
  const groups = useGroups();
  const fetchGroup = useFetchGroup();
  const { pull, push, busy } = useSyncActions(activeRepoId);

  // Effective binding for every command (defaults overlaid with user overrides).
  const keybindings = useSettings((s) => s.values.keybindings);
  const bindings = useMemo(() => resolveBindings(parseOverrides(keybindings)), [keybindings]);
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  // Latest dynamic state for the (mount-once) keydown listener, so it never
  // works off stale repo/group/mutation snapshots without re-binding. Built
  // once per render and reused as both the initializer and the live value.
  const snapshot = {
    activeRepoId,
    activeGroupId,
    repos: repos.data,
    groups: groups.data,
    fetchGroup,
    pull,
    push,
    busy,
    setActiveRepo,
    setActiveGroup,
    setView,
    toggleRepoSidebar,
    toggleTerminal,
    toggleTerminalMaximized,
    toggleSettings,
    toggleCommandPalette,
    focusRepoSearch,
    toggleTheme,
  };
  const ref = useRef(snapshot);
  ref.current = snapshot;

  useEffect(() => {
    // The repos shown in the active group, in sidebar order — kept in sync with
    // RepoSidebar's own filter so cycling and group-fetch match what's visible.
    function visibleRepos() {
      const s = ref.current;
      const group = (s.groups ?? []).find((g) => g.id === s.activeGroupId);
      return group?.is_default
        ? (s.repos ?? []).filter((r) => r.group_ids.length === 0)
        : (s.repos ?? []).filter(
            (r) => s.activeGroupId != null && r.group_ids.includes(s.activeGroupId),
          );
    }

    // Returns whether a cycle actually happened, so the caller can decide
    // whether to swallow the key (don't preventDefault when there's nothing
    // to cycle).
    function cycleRepo(dir: 1 | -1): boolean {
      const s = ref.current;
      const visible = visibleRepos();
      if (visible.length < 2) return false;
      const cur = visible.findIndex((r) => r.id === s.activeRepoId);
      const next = cur < 0 ? visible[0] : visible[(cur + dir + visible.length) % visible.length];
      s.setActiveRepo(next.id);
      ipc.touchRepo(next.id);
      return true;
    }

    // Fetch every fetchable repo in the active group (matches the group header's
    // fetch-all button — missing folders are skipped, they'd just error).
    function fetchActiveGroup() {
      const s = ref.current;
      if (s.fetchGroup.isPending) return;
      const ids = visibleRepos()
        .filter((r) => !r.missing)
        .map((r) => r.id);
      if (ids.length > 0) s.fetchGroup.mutate(ids);
    }

    function isTypingTarget(): boolean {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        el.isContentEditable ||
        el.closest(".monaco-editor, .xterm") != null
      );
    }

    // Each handler returns `false` to decline the event (so it isn't swallowed);
    // anything else means handled → preventDefault. Most always handle; only
    // repo-cycling declines when there's nothing to cycle to.
    const handlers: Record<ShortcutId, () => boolean | void> = {
      "view.files": () => ref.current.setView("files"),
      "view.history": () => ref.current.setView("history"),
      "view.review": () => ref.current.setView("review"),
      "view.pulls": () => ref.current.setView("pulls"),
      selectGroup1: () => selectGroup(1),
      selectGroup2: () => selectGroup(2),
      selectGroup3: () => selectGroup(3),
      selectGroup4: () => selectGroup(4),
      selectGroup5: () => selectGroup(5),
      selectGroup6: () => selectGroup(6),
      selectGroup7: () => selectGroup(7),
      selectGroup8: () => selectGroup(8),
      selectGroup9: () => selectGroup(9),
      toggleSidebar: () => ref.current.toggleRepoSidebar(),
      repoSearch: () => ref.current.focusRepoSearch(),
      toggleTheme: () => ref.current.toggleTheme(),
      commandPalette: () => ref.current.toggleCommandPalette(),
      toggleTerminal: () => ref.current.toggleTerminal(),
      maximizeTerminal: () => ref.current.toggleTerminalMaximized(),
      openSettings: () => ref.current.toggleSettings(),
      push: () => {
        const s = ref.current;
        if (s.activeRepoId != null && !s.busy) s.push.mutate();
      },
      pull: () => {
        const s = ref.current;
        if (s.activeRepoId != null && !s.busy) s.pull.mutate();
      },
      fetchGroup: () => fetchActiveGroup(),
      cycleRepoNext: () => cycleRepo(1),
      cycleRepoPrev: () => cycleRepo(-1),
    };

    // Select the Nth group in the rail (1-based), in rail order (`groups.data`).
    // Returns false for an out-of-range number so the key isn't swallowed.
    function selectGroup(n: number): boolean {
      const s = ref.current;
      const group = (s.groups ?? [])[n - 1];
      if (!group) return false;
      s.setActiveGroup(group.id);
      return true;
    }

    function onKey(e: KeyboardEvent) {
      const bindings = bindingsRef.current;
      const typing = isTypingTarget();
      for (const def of SHORTCUTS) {
        const binding: Binding = bindings[def.id];
        if (!matchesBinding(e, binding)) continue;
        // Suppressed while typing — let the keystroke through to the input.
        if (!def.whenTyping && typing) return;
        const handled = handlers[def.id]();
        if (handled !== false) e.preventDefault();
        return;
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
