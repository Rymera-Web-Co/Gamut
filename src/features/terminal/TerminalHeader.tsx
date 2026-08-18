import { useEffect, useRef, useState } from "react";
import {
  Folder,
  PanelLeft,
  PanelLeftClose,
  SplitSquareHorizontal,
  SplitSquareVertical,
} from "lucide-react";

import { useGroups, useRepos } from "@/features/repos/api";
import { pathBasename } from "@/lib/format";
import { groupToReveal } from "@/lib/groupRepos";
import { ipc, type Repo } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { termTabLabel, useUiStore, type SplitDirection } from "@/store/ui";
import { tabActivityKind, activityColor } from "./activity";

/**
 * Header bar above the full-view terminal: a clickable group / folder /
 * session breadcrumb on the left (group and folder jump back to the repo
 * workspace; the session name renames the terminal in place) and split +
 * "Open repo workspace" controls on the right.
 */
export function TerminalHeader() {
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const terminals = useUiStore((s) => s.terminals);
  const termActivity = useUiStore((s) => s.termActivity);
  const setTerminalOpen = useUiStore((s) => s.setTerminalOpen);
  const setActiveRepo = useUiStore((s) => s.setActiveRepo);
  const setActiveGroup = useUiStore((s) => s.setActiveGroup);
  const repoSidebarHidden = useUiStore((s) => s.repoSidebarHidden);
  const toggleRepoSidebar = useUiStore((s) => s.toggleRepoSidebar);
  const renameTerminalTab = useUiStore((s) => s.renameTerminalTab);
  const splitTerminal = useUiStore((s) => s.splitTerminal);

  const groups = useGroups();
  const repos = useRepos();
  const group = (groups.data ?? []).find((g) => g.id === activeGroupId);

  const gt = activeGroupId != null ? terminals[activeGroupId] : undefined;
  const tab = gt?.tabs.find((t) => t.id === gt.activeTabId);
  const cwd = tab?.panes.find((p) => p.id === tab.activePaneId)?.cwd ?? tab?.panes[0]?.cwd;
  const folder = cwd ? pathBasename(cwd) : undefined;
  const activity = tab ? tabActivityKind(tab, termActivity) : undefined;
  // The repo this session is rooted in, when its cwd is a registered repo (or
  // one of its worktrees isn't resolved here — plain path match only).
  const cwdRepo = cwd ? (repos.data ?? []).find((r) => r.path === cwd) : undefined;

  // Inline rename of the session name. Committing an empty draft reverts the
  // tab to its auto-derived title (renameTerminalTab's contract).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  // Switching tabs mid-edit would commit the draft onto the wrong tab — drop it.
  useEffect(() => setEditing(false), [tab?.id]);

  function commitRename() {
    if (activeGroupId != null && tab) renameTerminalTab(activeGroupId, tab.id, draft);
    setEditing(false);
  }

  // Jump back to the repo workspace, selecting the repo the session is rooted
  // in when we can resolve one. The repo may have left the session's group
  // since the terminal opened — switch to a group that actually contains it
  // (the shared groupToReveal rule) so the reconciler can't silently swap in
  // a different repo.
  // Shared by the two split buttons so they can only ever drift together.
  const splitButtonClass =
    "flex size-7 shrink-0 items-center justify-center rounded-md border bg-[var(--color-muted)] text-[var(--color-secondary-foreground)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)] disabled:opacity-40";
  const splitDisabled = !tab || !cwd || activeGroupId == null;
  function splitInto(direction: SplitDirection) {
    if (activeGroupId == null || !tab || !cwd) return;
    splitTerminal(activeGroupId, cwd, direction);
  }

  function openWorkspace(target?: Repo) {
    if (target) {
      const activeGroup = (groups.data ?? []).find((g) => g.id === activeGroupId);
      const groupId = groupToReveal(target, activeGroup, groups.data ?? []);
      if (groupId != null) setActiveGroup(groupId);
      setActiveRepo(target.id);
      ipc.touchRepo(target.id);
    }
    setTerminalOpen(false);
  }

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b bg-[var(--color-card)] pl-2 pr-4">
      <button
        aria-label={repoSidebarHidden ? "Show sidebar" : "Hide sidebar"}
        title={repoSidebarHidden ? "Show sidebar (⌘B)" : "Hide sidebar (⌘B)"}
        onClick={toggleRepoSidebar}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
      >
        {repoSidebarHidden ? (
          <PanelLeft className="size-4" />
        ) : (
          <PanelLeftClose className="size-4" />
        )}
      </button>
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", !activity && "gamut-pulse")}
        style={{ background: activity ? activityColor(activity) : "var(--color-primary)" }}
      />
      <div className="flex min-w-0 items-baseline gap-2 text-[13px]">
        {group && (
          <>
            <button
              title={`Open ${group.name} in the repo workspace`}
              onClick={() => openWorkspace(cwdRepo)}
              className="truncate text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] hover:underline"
            >
              {group.name}
            </button>
            <span className="text-[var(--color-faint)]">/</span>
          </>
        )}
        {folder && (
          <>
            <button
              title={
                cwdRepo ? `Open ${cwdRepo.name} in the repo workspace` : "Open the repo workspace"
              }
              onClick={() => openWorkspace(cwdRepo)}
              className="truncate text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] hover:underline"
            >
              {folder}
            </button>
            <span className="text-[var(--color-faint)]">/</span>
          </>
        )}
        {editing && tab ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setEditing(false);
            }}
            aria-label="Rename terminal"
            className="w-48 rounded border border-[var(--color-border)] bg-[var(--color-background)] px-1.5 py-0.5 text-[13px] font-semibold text-[var(--color-foreground)] outline-none focus:border-[var(--color-primary)]"
          />
        ) : (
          <button
            title={tab ? "Rename terminal" : undefined}
            disabled={!tab}
            onClick={() => {
              if (!tab) return;
              setDraft(termTabLabel(tab));
              setEditing(true);
            }}
            className="truncate font-semibold text-[var(--color-foreground)]"
          >
            {tab ? termTabLabel(tab) : "Terminal"}
          </button>
        )}
      </div>
      <div className="flex-1" />
      {/* The tab is a grid (#316): split right adds a pane beside the active
          one, split down adds a new row below it — any mix, so both are always
          available while a session exists. */}
      <button
        aria-label="Split terminal right"
        title="Split right (⌘D)"
        disabled={splitDisabled}
        onClick={() => splitInto("row")}
        className={splitButtonClass}
      >
        <SplitSquareHorizontal className="size-3.5" />
      </button>
      <button
        aria-label="Split terminal down"
        title="Split down (⌘⇧D)"
        disabled={splitDisabled}
        onClick={() => splitInto("column")}
        className={splitButtonClass}
      >
        <SplitSquareVertical className="size-3.5" />
      </button>
      <button
        onClick={() => openWorkspace(cwdRepo)}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border bg-[var(--color-muted)] px-2.5 text-xs font-medium text-[var(--color-secondary-foreground)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
      >
        <Folder className="size-3.5" />
        Open repo workspace
      </button>
    </div>
  );
}
