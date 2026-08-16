import { useEffect, useMemo, useRef } from "react";

import { useFetchGroup, useGroups, useRepos } from "@/features/repos/api";
import { branchAwaitingPublish } from "@/features/sync/pushGate";
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
 *   ⌘/Ctrl+1–9 → select the Nth group in the sidebar (cmux-style; issue #95)
 *   ⌃1–4 → Files / History / Review / Pull Requests
 *   ⌘/Ctrl+B sidebar   ⌘/Ctrl+⇧+F repo-wide search   ⌘/Ctrl+J theme
 *   ⌘/Ctrl+K command palette   ⌘/Ctrl+` terminal view
 *   ⌘/Ctrl+, settings   ⌥Z toggle editor word wrap
 *   ⌘/Ctrl+⇧+K push   ⌘/Ctrl+⇧+P pull
 *   ⌘/Ctrl+⌥+F fetch group   ⌘/Ctrl+↑/↓ cycle groups in the sidebar
 *   ⌃Tab / ⌃⇧Tab cycle repos in the active group
 *
 * Per-file find/replace (⌘/Ctrl+F, ⌘/Ctrl+H) is handled in the Files view, and
 * terminal tab shortcuts (⌘T/⌘W/⌘D/⌘⇧[ ]/⌘⌥1–9) live in TerminalPane.
 *
 * Commands flagged `whenTyping: false` (git sync, repo cycling) are suppressed
 * while the user is typing in an input, the editor, or a terminal, so they don't
 * clash with editor bindings such as Monaco's ⌘⇧K (delete line).
 */
export function useKeyboardShortcuts() {
  const showView = useUiStore((s) => s.showView);
  const toggleRepoSidebar = useUiStore((s) => s.toggleRepoSidebar);
  const toggleTerminal = useUiStore((s) => s.toggleTerminal);
  const toggleSettings = useUiStore((s) => s.toggleSettings);
  const toggleCommandPalette = useUiStore((s) => s.toggleCommandPalette);
  const focusRepoSearch = useUiStore((s) => s.focusRepoSearch);
  const requestPushConfirm = useUiStore((s) => s.requestPushConfirm);
  const setActiveRepo = useUiStore((s) => s.setActiveRepo);
  const setActiveGroup = useUiStore((s) => s.setActiveGroup);
  const setTerminalOpen = useUiStore((s) => s.setTerminalOpen);
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
    requestPushConfirm,
    setActiveRepo,
    setActiveGroup,
    setTerminalOpen,
    showView,
    toggleRepoSidebar,
    toggleTerminal,
    toggleSettings,
    toggleCommandPalette,
    focusRepoSearch,
    toggleTheme,
  };
  const ref = useRef(snapshot);
  ref.current = snapshot;

  // True while the push shortcut's "would this publish a new branch?" check is
  // in flight — see the `push` handler.
  const pushGateBusy = useRef(false);

  useEffect(() => {
    // The repos shown in the active group, in sidebar order — kept in sync with
    // the Sidebar's group filter so cycling and group-fetch match what's visible.
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
      // Cycling repos means "show me the workspace" — leave the terminal view.
      s.setTerminalOpen(false);
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
      "view.files": () => ref.current.showView("files"),
      "view.history": () => ref.current.showView("history"),
      "view.review": () => ref.current.showView("review"),
      "view.pulls": () => ref.current.showView("pulls"),
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
      openSettings: () => ref.current.toggleSettings(),
      toggleWordWrap: () => {
        // Flip the persisted setting; every editor/diff/blame surface reads it
        // reactively, so the change takes effect immediately and survives reopen.
        const s = useSettings.getState();
        s.set("editorWordWrap", !s.values.editorWordWrap);
      },
      push: () => {
        const s = ref.current;
        // `busy` only covers a push already running; the gate below is a round
        // trip of its own, and key auto-repeat would otherwise fire a fresh one
        // (and eventually a duplicate push) every few milliseconds.
        if (s.activeRepoId == null || s.busy || pushGateBusy.current) return;
        const repoId = s.activeRepoId;
        // Publishing a branch that has no upstream is more consequential than a
        // push to one that tracks, so it gets confirmed rather than going
        // through silently (#300). Asking the backend costs a round trip, but it
        // is the only answer that can't be stale — a branch created moments ago
        // is exactly the case this guards.
        pushGateBusy.current = true;
        void branchAwaitingPublish(repoId).then((branch) => {
          pushGateBusy.current = false;
          // `push.mutate` follows whichever repo is active *now*, so if the
          // selection moved while the gate was in flight, pushing would hit a
          // repo the user never asked about — and skip its own confirmation,
          // since the answer we hold is about the old one. Drop it instead.
          if (ref.current.activeRepoId !== repoId) return;
          if (branch) ref.current.requestPushConfirm(repoId, branch);
          else ref.current.push.mutate();
        });
      },
      pull: () => {
        const s = ref.current;
        if (s.activeRepoId != null && !s.busy) s.pull.mutate();
      },
      fetchGroup: () => fetchActiveGroup(),
      cycleGroupPrev: () => cycleGroup(-1),
      cycleGroupNext: () => cycleGroup(1),
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

    // Step to the previous/next group in rail order, wrapping at the ends — the
    // group-level counterpart to `cycleRepo`. Returns false when there are fewer
    // than two groups so the key isn't swallowed.
    function cycleGroup(dir: 1 | -1): boolean {
      const s = ref.current;
      const list = s.groups ?? [];
      if (list.length < 2) return false;
      const cur = list.findIndex((g) => g.id === s.activeGroupId);
      const next = cur < 0 ? list[0] : list[(cur + dir + list.length) % list.length];
      s.setActiveGroup(next.id);
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
