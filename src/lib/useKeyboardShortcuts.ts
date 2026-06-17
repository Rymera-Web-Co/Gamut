import { useEffect, useRef } from "react";

import { useFetchGroup, useGroups, useRepos } from "@/features/repos/api";
import { useSyncActions } from "@/features/sync/useSyncActions";
import { ipc } from "@/lib/ipc";
import { useTheme } from "@/lib/theme";
import { useUiStore } from "@/store/ui";

/**
 * Global shortcuts:
 *   ⌘/Ctrl+1 → Files   ⌘/Ctrl+2 → History   ⌘/Ctrl+3 → Review
 *   ⌘/Ctrl+4 → Pull Requests
 *   ⌘/Ctrl+B → toggle repo sidebar   ⌘/Ctrl+J → toggle theme
 *   ⌘/Ctrl+⇧+F → repo-wide search (Files view)
 *   ⌘/Ctrl+` → toggle integrated terminal
 *   ⌘/Ctrl+⇧+` → maximize / restore the terminal
 *   ⌘/Ctrl+, → settings
 *   ⌘/Ctrl+⇧+K → push   ⌘/Ctrl+⇧+P → pull (active repo)
 *   ⌘/Ctrl+⌥+F → fetch all repos in the active group
 *   ⌃Tab / ⌃⇧Tab → cycle repos in the active group
 *
 * Per-file find/replace (⌘/Ctrl+F, ⌘/Ctrl+H) is handled in the Files view,
 * where the Monaco instance lives. Terminal tab shortcuts (⌘T/⌘W/⌘D/⌘⇧[ ]/
 * ⌘⌥1–9) live in TerminalPane, which owns the PTY sessions.
 *
 * Git-sync and repo-cycle shortcuts are suppressed while the user is typing
 * (editor, terminal, inputs) so they don't clash with editor bindings such as
 * Monaco's ⌘⇧K (delete line).
 */
export function useKeyboardShortcuts() {
  const setView = useUiStore((s) => s.setView);
  const toggleRepoSidebar = useUiStore((s) => s.toggleRepoSidebar);
  const toggleTerminal = useUiStore((s) => s.toggleTerminal);
  const toggleTerminalMaximized = useUiStore((s) => s.toggleTerminalMaximized);
  const toggleSettings = useUiStore((s) => s.toggleSettings);
  const focusRepoSearch = useUiStore((s) => s.focusRepoSearch);
  const setActiveRepo = useUiStore((s) => s.setActiveRepo);
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const toggleTheme = useTheme((s) => s.toggle);

  const repos = useRepos();
  const groups = useGroups();
  const fetchGroup = useFetchGroup();
  const { pull, push, busy } = useSyncActions(activeRepoId);

  // Latest dynamic state for the (mount-once) keydown listener, so it never
  // works off stale repo/group/mutation snapshots without re-binding.
  const ref = useRef({
    activeRepoId,
    activeGroupId,
    repos: repos.data,
    groups: groups.data,
    fetchGroup,
    pull,
    push,
    busy,
    setActiveRepo,
  });
  ref.current = {
    activeRepoId,
    activeGroupId,
    repos: repos.data,
    groups: groups.data,
    fetchGroup,
    pull,
    push,
    busy,
    setActiveRepo,
  };

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

    function cycleRepo(dir: 1 | -1) {
      const s = ref.current;
      const visible = visibleRepos();
      if (visible.length < 2) return;
      const cur = visible.findIndex((r) => r.id === s.activeRepoId);
      const next =
        cur < 0 ? visible[0] : visible[(cur + dir + visible.length) % visible.length];
      s.setActiveRepo(next.id);
      ipc.touchRepo(next.id);
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

    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;

      // Repo-action / repo-cycle shortcuts: only when not typing somewhere.
      if (!isTypingTarget()) {
        const s = ref.current;
        // ⌘⌥F → fetch the active group. ⌥ combos mangle e.key on macOS, so
        // match the physical code instead.
        if (e.altKey && e.code === "KeyF") {
          e.preventDefault();
          fetchActiveGroup();
          return;
        }
        // ⌃Tab / ⌃⇧Tab → cycle repos in the active group.
        if (e.key === "Tab") {
          e.preventDefault();
          cycleRepo(e.shiftKey ? -1 : 1);
          return;
        }
        if (!e.altKey) {
          // ⌘⇧K → push, ⌘⇧P → pull (shift letters arrive uppercase).
          if (e.key === "K") {
            e.preventDefault();
            if (s.activeRepoId != null && !s.busy) s.push.mutate();
            return;
          }
          if (e.key === "P") {
            e.preventDefault();
            if (s.activeRepoId != null && !s.busy) s.pull.mutate();
            return;
          }
        }
      }

      // No other ⌥ combos are handled here.
      if (e.altKey) return;

      switch (e.key) {
        case "1":
          e.preventDefault();
          setView("files");
          break;
        case "2":
          e.preventDefault();
          setView("history");
          break;
        case "3":
          e.preventDefault();
          setView("review");
          break;
        case "4":
          e.preventDefault();
          setView("pulls");
          break;
        case "b":
          e.preventDefault();
          toggleRepoSidebar();
          break;
        // ⇧+F arrives as "F"; opens repo-wide search (plain ⌘/Ctrl+F is the
        // editor's per-file find, handled in the Files view).
        case "F":
          e.preventDefault();
          focusRepoSearch();
          break;
        case "j":
          e.preventDefault();
          toggleTheme();
          break;
        case "`":
          e.preventDefault();
          toggleTerminal();
          break;
        // Shift+` reports as "~" on most layouts.
        case "~":
          e.preventDefault();
          toggleTerminalMaximized();
          break;
        case ",":
          e.preventDefault();
          toggleSettings();
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    setView,
    toggleRepoSidebar,
    toggleTerminal,
    toggleTerminalMaximized,
    toggleSettings,
    focusRepoSearch,
    toggleTheme,
  ]);
}
