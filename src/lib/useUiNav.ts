import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

import { setPendingCommand } from "@/features/terminal/pendingCommands";
import { repoInGroup } from "@/lib/groupRepos";
import { ipc } from "@/lib/ipc";
import { useUiStore, type View } from "@/store/ui";

/**
 * A UI-navigation command from the `gamut` CLI's control channel (issue #15,
 * Phase 2). The backend re-emits the CLI's request verbatim as a `ui-nav`
 * event; field names are snake_case to match the Rust payload.
 */
interface UiNav {
  /** "select-repo" | "view" | "open" | "goto" | "term" */
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
}

const VIEWS: readonly View[] = ["files", "history", "review", "pulls"];

function asView(v: string | undefined): View | null {
  return v && (VIEWS as readonly string[]).includes(v) ? (v as View) : null;
}

/**
 * Open a terminal tab for a repo and (optionally) run a command in it — the
 * `gamut term` flow. The integrated terminal is per-group, so we open it in a
 * group the repo is actually visible in and switch the view there; otherwise the
 * active-repo reconciler would revert the selection and the tab would be
 * stranded under a group that doesn't list the repo. The command is queued
 * against the new pane and typed in once its PTY spawns (see `pendingCommands`).
 */
async function openTerm(nav: UiNav): Promise<void> {
  const ui = useUiStore.getState();
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

  ui.setActiveGroup(groupId);
  if (nav.repo_id != null) ui.setActiveRepo(nav.repo_id);

  const paneId = ui.addTerminalTab(groupId, nav.cwd ?? "", nav.title ?? "terminal");
  if (nav.command) {
    // CR (\r) is what Enter sends, so append it to execute; omit to leave the
    // command staged at the prompt (--no-run).
    setPendingCommand(paneId, nav.run === false ? nav.command : `${nav.command}\r`);
  }
}

/**
 * Apply UI-navigation commands sent by the `gamut` CLI to the running window.
 * Each command is routed through the existing one-shot deep-link store hooks
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
          if (v) ui.setView(v);
          break;
        }
        case "open":
          if (repo_id != null) ui.setActiveRepo(repo_id);
          ui.setView("files");
          if (path) ui.setFilesPath(path);
          break;
        case "goto":
          if (repo_id != null) ui.setActiveRepo(repo_id);
          ui.setView("history");
          if (sha) ui.setHistorySha(sha);
          break;
        case "term":
          void openTerm(ev.payload);
          break;
      }
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, []);
}
