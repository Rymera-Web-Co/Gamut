import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

import { setPendingCommand } from "@/features/terminal/pendingCommands";
import { repoInGroup } from "@/lib/groupRepos";
import { ipc } from "@/lib/ipc";
import { useUiStore, type View } from "@/store/ui";

/**
 * A UI-navigation command from the local control channel. The backend re-emits
 * the request verbatim as a `ui-nav` event; field names are snake_case to match
 * the Rust payload.
 */
interface UiNav {
  /** "select-repo" | "view" | "open" | "goto" | "term" | "term-send" | "term-close" | "term-rename" */
  action: string;
  repo_id?: number;
  view?: string;
  path?: string;
  sha?: string;
  /** `term` only: working dir, tab title, command to type, and whether to run it. */
  cwd?: string;
  title?: string;
  command?: string;
  run?: boolean;
  /** `term` only: reuse an existing terminal named `title` instead of opening a new one. */
  reuse?: boolean;
  /** `term` only: open in the background — create + start the terminal without
   * switching the active group/repo/view or revealing the terminal panel. */
  silent?: boolean;
  /** `term-send` only: text to type into the existing terminal named `title`. */
  text?: string;
  /** `term-rename` only: the new name for the existing terminal named `title`. */
  rename_to?: string;
}

/**
 * Gap (ms) between typing `term-send` text and sending the submitting Enter.
 * They must arrive as two separate PTY writes: a TUI like Claude Code treats a
 * text+CR burst as a paste and buffers the newline instead of submitting, so we
 * write the text, let it settle, then send a lone CR that registers as Enter.
 */
const TERM_SEND_SUBMIT_DELAY_MS = 150;

const VIEWS: readonly View[] = ["files", "history", "review", "pulls"];

function asView(v: string | undefined): View | null {
  return v && (VIEWS as readonly string[]).includes(v) ? (v as View) : null;
}

/**
 * Open a terminal tab for a repo and (optionally) run a command in it — the
 * `term` control command. The integrated terminal is per-group, so we open it in
 * a group the repo is actually visible in and switch the view there; otherwise the
 * active-repo reconciler would revert the selection and the tab would be
 * stranded under a group that doesn't list the repo. The command is queued
 * against the new pane and typed in once its PTY spawns (see `pendingCommands`).
 */
async function openTerm(nav: UiNav): Promise<void> {
  const ui = useUiStore.getState();
  const silent = nav.silent === true;
  let groupId = ui.activeGroupId;

  try {
    const [repos, groups] = await Promise.all([ipc.listRepos(), ipc.listGroups()]);
    const repo = nav.repo_id != null ? repos.find((r) => r.id === nav.repo_id) : undefined;
    const defaultGroupId = (groups.find((g) => g.is_default) ?? groups[0])?.id ?? null;

    if (repo) {
      const current = groups.find((g) => g.id === groupId);
      // Stay in the current group if the repo already lives there; otherwise jump
      // to the repo's first group, or the default group when it's ungrouped.
      if (!(current && repoInGroup(repo, current))) {
        groupId = repo.group_ids[0] ?? defaultGroupId;
      }
    } else if (groupId == null) {
      groupId = defaultGroupId;
    }
  } catch {
    // Couldn't load the tree — fall back to whatever group is active.
  }
  if (groupId == null) return;

  // Silent (`--silent`): create and start the terminal in the background — don't
  // switch the active group/repo or reveal the panel. The session manager spawns
  // its PTY eagerly (see `requestBackgroundTerminal`) so a queued command still
  // runs; the user can navigate to it later. Otherwise, focus it as usual.
  if (!silent) {
    ui.setActiveGroup(groupId);
    if (nav.repo_id != null) ui.setActiveRepo(nav.repo_id);
  }

  const name = nav.title ?? "terminal";

  // Queue the command for a pane (typed once its PTY is ready). CR (\r) is what
  // Enter sends, so append it to execute; omit to leave it staged (--no-run).
  const queue = (paneId: string) => {
    if (nav.command) {
      setPendingCommand(paneId, nav.run === false ? nav.command : `${nav.command}\r`);
    }
  };

  // `--name` (reuse): if a terminal with this name already exists in the group,
  // run the command in it; otherwise fall through and open a new named tab.
  if (nav.reuse) {
    const group = useUiStore.getState().terminals[groupId];
    const existing = group?.tabs.find((t) => (t.customTitle ?? t.title) === name);
    if (existing) {
      queue(existing.activePaneId);
      // Silent reuse drives the (possibly backgrounded) PTY without stealing
      // focus; otherwise reveal + focus the existing tab as before.
      if (silent) ui.requestBackgroundTerminal(existing.activePaneId);
      else ui.focusTerminal(groupId, existing.id, existing.activePaneId);
      return;
    }
  }

  const paneId = ui.addTerminalTab(groupId, nav.cwd ?? "", name, { background: silent });
  queue(paneId);
  if (silent) ui.requestBackgroundTerminal(paneId);
}

/**
 * The terminal group(s) a repo's tabs live in — the repo's own groups, or the
 * default group when it's ungrouped. Empty on any lookup failure. Shared by the
 * `term-close` / `term-send` / `term-rename` handlers, which each resolve a tab
 * by name within these groups (mirroring where `term` would have opened it).
 */
async function resolveRepoGroupIds(repoId: number): Promise<number[]> {
  try {
    const [repos, groups] = await Promise.all([ipc.listRepos(), ipc.listGroups()]);
    const repo = repos.find((r) => r.id === repoId);
    if (!repo) return [];
    const defaultGroupId = (groups.find((g) => g.is_default) ?? groups[0])?.id;
    return repo.group_ids.length > 0
      ? repo.group_ids
      : defaultGroupId != null
        ? [defaultGroupId]
        : [];
  } catch {
    return [];
  }
}

/**
 * Close a terminal tab by name — the `term-close` control command. Searches the
 * groups the repo belongs to (where `term` would have opened it) and closes the
 * first tab whose name matches; the session manager reaps its PTY. No-op if
 * there's no match, and it never disturbs the active group/view.
 */
async function closeTerm(nav: UiNav): Promise<void> {
  const name = nav.title;
  if (!name || nav.repo_id == null) return;

  const groupIds = await resolveRepoGroupIds(nav.repo_id);
  const ui = useUiStore.getState();
  for (const gid of groupIds) {
    const tab = ui.terminals[gid]?.tabs.find((t) => (t.customTitle ?? t.title) === name);
    if (tab) {
      ui.closeTerminalTab(gid, tab.id);
      return;
    }
  }
}

/**
 * Rename an existing terminal tab — the `term-rename` control command. Finds the
 * tab named `title` in the repo's group(s) (where `term` would have opened it)
 * and gives it `rename_to` as its new name; subsequent `term-send`/`term-close`/
 * reuse lookups then match the new name. No-op if the tab doesn't exist or the
 * new name is empty, and it never disturbs the active group/view.
 */
async function renameTerm(nav: UiNav): Promise<void> {
  const name = nav.title;
  const next = nav.rename_to?.trim();
  if (!name || !next || nav.repo_id == null) return;

  const groupIds = await resolveRepoGroupIds(nav.repo_id);
  const ui = useUiStore.getState();
  for (const gid of groupIds) {
    const tab = ui.terminals[gid]?.tabs.find((t) => (t.customTitle ?? t.title) === name);
    if (tab) {
      ui.renameTerminalTab(gid, tab.id, next);
      return;
    }
  }
}

/**
 * Type text into an existing terminal tab and submit it — the `term-send`
 * control command. Finds the tab named `title` in the repo's group(s) (where
 * `term` would have opened it), reveals it, writes the text to its live pane,
 * then sends a lone CR after a short delay so it submits instead of reading as a
 * paste (see {@link TERM_SEND_SUBMIT_DELAY_MS}). No-op if the tab doesn't exist.
 */
async function sendTerm(nav: UiNav): Promise<void> {
  const name = nav.title;
  if (!name || nav.repo_id == null || !nav.text) return;

  const groupIds = await resolveRepoGroupIds(nav.repo_id);
  const ui = useUiStore.getState();
  const encoder = new TextEncoder();
  for (const gid of groupIds) {
    const tab = ui.terminals[gid]?.tabs.find((t) => (t.customTitle ?? t.title) === name);
    if (tab) {
      const paneId = tab.activePaneId;
      // Reveal the tab so the human watches the session pick the answer up.
      ui.focusTerminal(gid, tab.id, paneId);
      ipc.terminalWrite(paneId, encoder.encode(nav.text)).catch(() => {});
      // Submit with a separate CR after the text settles (paste-vs-keystroke).
      setTimeout(() => {
        void ipc.terminalWrite(paneId, encoder.encode("\r")).catch(() => {});
      }, TERM_SEND_SUBMIT_DELAY_MS);
      return;
    }
  }
}

/**
 * Apply UI-navigation commands from the local control channel to the running
 * window. Each command is routed through the existing one-shot deep-link store hooks
 * (`setActiveRepo` / `setView` / `setFilesPath` / `setHistorySha`); the Files
 * and History views then consume `filesPath` / `historySha` as they already do
 * for in-app deep links, so no new navigation model is introduced.
 */
export function useUiNav() {
  useEffect(() => {
    const unlisten = listen<UiNav>("ui-nav", (ev) => {
      const { action, repo_id, view, path, sha } = ev.payload;
      const ui = useUiStore.getState();

      switch (action) {
        case "select-repo":
          if (repo_id != null) ui.setActiveRepo(repo_id);
          break;
        case "view": {
          const v = asView(view);
          if (v) ui.showView(v);
          break;
        }
        case "open":
          if (repo_id != null) ui.setActiveRepo(repo_id);
          ui.showView("files");
          if (path) ui.setFilesPath(path);
          break;
        case "goto":
          if (repo_id != null) ui.setActiveRepo(repo_id);
          ui.showView("history");
          if (sha) ui.setHistorySha(sha);
          break;
        case "term":
          void openTerm(ev.payload);
          break;
        case "term-send":
          void sendTerm(ev.payload);
          break;
        case "term-close":
          void closeTerm(ev.payload);
          break;
        case "term-rename":
          void renameTerm(ev.payload);
          break;
      }
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, []);
}
