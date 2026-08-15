import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronRight,
  Copy,
  Folder,
  FolderGit2,
  FolderSearch,
  GitBranch,
  Globe,
  Link as LinkIcon,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";

import {
  ContextMenu,
  ContextMenuItem,
  type ContextMenuPosition,
} from "@/components/ui/context-menu";
import { GitHubConnect } from "@/features/github/GitHubConnect";
import { AutoPullMenuItem } from "@/features/repos/AutoPullMenuItem";
import { ConfirmRemoveReposDialog } from "@/features/repos/ConfirmRemoveReposDialog";
import { DiscoverDialog } from "@/features/repos/DiscoverDialog";
import { GroupDialog } from "@/features/repos/GroupDialog";
import {
  useFetchGroup,
  useGroups,
  useLinkedWorktrees,
  useRegisterRepo,
  useRemoveRepos,
  useRepoRemoteUrl,
  useRepoStatuses,
  useRepos,
  useSetRepoGroups,
} from "@/features/repos/api";
import { activityColor, groupActivityKind, tabActivityKind } from "@/features/terminal/activity";
import { canAutoPull } from "@/lib/autoPull";
import { copy } from "@/lib/clipboard";
import { GROUP_ICONS, groupInitials } from "@/lib/groupIcons";
import { visibleRepos } from "@/lib/groupRepos";
import {
  ipc,
  pickDirectory,
  type Group,
  type LinkedWorktree,
  type Repo,
  type RepoStatus,
} from "@/lib/ipc";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { termTabLabel, useUiStore, type TermActivityKind, type TermTab } from "@/store/ui";

/** Last path segment of a cwd, for the terminal row's meta line. */
function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Right-aligned state label for a terminal row's unseen activity. */
function activityLabel(kind: TermActivityKind): string {
  switch (kind) {
    case "exit":
      return "exited";
    case "bell":
      return "needs input";
    default:
      return "active";
  }
}

/**
 * One terminal session row in the flat, cross-group rail at the top of the
 * sidebar. Clicking focuses that terminal (group + tab + pane); the hover X
 * kills its panes' PTYs and drops the tab (ports the popup close control,
 * #280).
 */
function TerminalRow({ group, tab }: { group: Group; tab: TermTab }) {
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const terminalOpen = useUiStore((s) => s.terminalOpen);
  const terminals = useUiStore((s) => s.terminals);
  const termActivity = useUiStore((s) => s.termActivity);
  const focusTerminal = useUiStore((s) => s.focusTerminal);
  const closeTerminalTab = useUiStore((s) => s.closeTerminalTab);

  const activity = tabActivityKind(tab, termActivity);
  const current =
    terminalOpen && group.id === activeGroupId && terminals[group.id]?.activeTabId === tab.id;
  const cwd = tab.panes[0]?.cwd ?? "";

  function close(e: React.MouseEvent) {
    e.stopPropagation();
    tab.panes.forEach((pane) => {
      ipc.terminalKill(pane.id).catch(() => {});
    });
    closeTerminalTab(group.id, tab.id);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => focusTerminal(group.id, tab.id, tab.activePaneId)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          focusTerminal(group.id, tab.id, tab.activePaneId);
        }
      }}
      className={cn(
        "group/term flex cursor-pointer items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 transition-colors",
        current
          ? "border-[var(--color-border)] bg-[var(--color-card)] shadow-sm"
          : "hover:bg-[var(--color-accent)]",
      )}
    >
      <span
        aria-hidden
        className="size-[7px] shrink-0 rounded-full"
        style={{
          background: activity ? activityColor(activity) : "var(--color-primary)",
          animation: activity ? undefined : "gamut-pulse 1.6s ease-in-out infinite",
        }}
      />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate text-[12.5px] leading-[17px]",
            current
              ? "font-semibold text-[var(--color-foreground)]"
              : "font-medium text-[var(--color-secondary-foreground)]",
          )}
        >
          {termTabLabel(tab)}
        </div>
        <div className="truncate text-[11px] leading-[15px] text-[var(--color-muted-foreground)]">
          {group.name}
          {cwd ? ` · ${basename(cwd)}` : ""}
        </div>
      </div>
      {activity && (
        <span
          className="shrink-0 text-[11px] font-semibold group-focus-within/term:hidden group-hover/term:hidden"
          style={{ color: activityColor(activity) }}
        >
          {activityLabel(activity)}
        </span>
      )}
      {/* `hidden` would drop the control from the tab order, so keyboard users
          could never reach it — reveal on focus-within too (row + button). */}
      <button
        aria-label={`Close ${termTabLabel(tab)} terminal`}
        title="Close terminal"
        onClick={close}
        className="hidden size-5 shrink-0 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-secondary)] hover:text-[var(--color-foreground)] group-focus-within/term:flex group-hover/term:flex"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * One linked worktree, nested under its repo row. Selecting it keeps the repo
 * active for the content views but roots new terminals at the worktree's
 * checkout.
 */
function WorktreeRow({
  repo,
  groupId,
  worktree,
}: {
  repo: Repo;
  groupId: number;
  worktree: LinkedWorktree;
}) {
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  const activeWorktreePath = useUiStore((s) => s.activeWorktreePath);
  const setActiveRepo = useUiStore((s) => s.setActiveRepo);
  const addTerminalTab = useUiStore((s) => s.addTerminalTab);
  const active = activeRepoId === repo.id && activeWorktreePath === worktree.path;
  const label =
    worktree.branch ?? worktree.path.split(/[\\/]/).filter(Boolean).pop() ?? worktree.path;

  const activate = () => {
    if (worktree.missing) return;
    setActiveRepo(repo.id, worktree.path);
    ipc.touchRepo(repo.id);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      title={worktree.missing ? "Checkout folder no longer exists on disk" : worktree.path}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      }}
      className={cn(
        "group/wt ml-5 flex cursor-pointer items-center gap-2 rounded-md border border-transparent py-1 pl-2 pr-2 text-xs",
        worktree.missing && "cursor-default opacity-60",
        active
          ? "border-[var(--color-border)] bg-[var(--color-card)] font-medium text-[var(--color-foreground)]"
          : "text-[var(--color-secondary-foreground)] hover:bg-[var(--color-accent)]",
      )}
    >
      {worktree.missing ? (
        <AlertTriangle className="size-3.5 shrink-0 text-[var(--color-destructive)]" />
      ) : (
        <GitBranch
          className={cn(
            "size-3.5 shrink-0",
            active ? "text-[var(--color-primary)]" : "text-[var(--color-muted-foreground)]",
          )}
        />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate leading-tight",
          worktree.missing && "line-through decoration-[var(--color-destructive)]/60",
        )}
      >
        {label}
      </span>
      {/* Revealed on focus-within too so keyboard users can reach it. */}
      {!worktree.missing && (
        <button
          aria-label={`Open terminal in ${repo.name} (${label})`}
          title="Open terminal here"
          onClick={(e) => {
            e.stopPropagation();
            addTerminalTab(groupId, worktree.path, `${repo.name} (${label})`);
          }}
          className="hidden size-5 shrink-0 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-secondary)] hover:text-[var(--color-primary)] group-focus-within/wt:flex group-hover/wt:flex"
        >
          <SquareTerminal className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** One repo row inside an expanded group. */
function RepoRow({
  repo,
  groupId,
  status,
  isSyncedRoot = false,
  onContextMenu,
}: {
  repo: Repo;
  groupId: number;
  status?: RepoStatus;
  /** This repo is a folder-bound group's synced root — tagged with a badge. */
  isSyncedRoot?: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  const activeWorktreePath = useUiStore((s) => s.activeWorktreePath);
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const setActiveGroup = useUiStore((s) => s.setActiveGroup);
  const setActiveRepo = useUiStore((s) => s.setActiveRepo);
  const addTerminalTab = useUiStore((s) => s.addTerminalTab);
  const active =
    activeRepoId === repo.id && activeGroupId === groupId && activeWorktreePath == null;

  // Only run `git worktree list` for repos that actually have linked worktrees
  // (live status flag wins once loaded; the persisted flag gates the first scan).
  const hasWorktrees = status?.has_worktrees ?? repo.has_worktrees;
  const worktrees = useLinkedWorktrees(repo.id, repo.is_git_repo && !repo.missing && hasWorktrees);

  const activate = () => {
    setActiveGroup(groupId);
    setActiveRepo(repo.id);
    ipc.touchRepo(repo.id);
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        title={repo.missing ? "Folder no longer exists on disk" : repo.path}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e);
        }}
        className={cn(
          "group/repo flex min-h-7 cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 text-[12.5px]",
          repo.missing && "opacity-60",
          active
            ? "border-[var(--color-border)] bg-[var(--color-card)] font-medium text-[var(--color-foreground)] shadow-sm"
            : "text-[var(--color-secondary-foreground)] hover:bg-[var(--color-accent)]",
        )}
      >
        {repo.missing ? (
          <AlertTriangle className="size-3.5 shrink-0 text-[var(--color-destructive)]" />
        ) : repo.is_git_repo ? (
          <FolderGit2
            className={cn(
              "size-3.5 shrink-0",
              active ? "text-[var(--color-primary)]" : "text-[var(--color-faint)]",
            )}
          />
        ) : (
          <Folder
            className="size-3.5 shrink-0 text-[var(--color-faint)]"
            aria-label="Not a git repository"
          />
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate leading-tight",
            repo.missing && "line-through decoration-[var(--color-destructive)]/60",
          )}
        >
          {repo.name}
        </span>
        {isSyncedRoot && (
          <span
            title="This group’s synced folder (root)"
            className="shrink-0 rounded bg-[var(--color-primary-soft)] px-1 py-px text-[9px] font-semibold uppercase leading-tight tracking-wide text-[var(--color-primary)]"
          >
            root
          </span>
        )}
        {!repo.missing && repo.is_git_repo && status?.has_uncommitted_changes && (
          <span
            aria-label="Uncommitted changes"
            title="Uncommitted changes"
            className="size-1.5 shrink-0 rounded-full bg-[var(--color-warning)]"
          />
        )}
        {status?.branch && (
          <span className="shrink-0 text-[11px] text-[var(--color-faint)] group-focus-within/repo:hidden group-hover/repo:hidden">
            {status.branch}
          </span>
        )}
        {/* Revealed on focus-within too so keyboard users can reach it. */}
        {!repo.missing && (
          <button
            aria-label={`Open terminal in ${repo.name}`}
            title="Open terminal here"
            onClick={(e) => {
              e.stopPropagation();
              addTerminalTab(groupId, repo.path, repo.name);
            }}
            className="hidden size-5 shrink-0 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-secondary)] hover:text-[var(--color-primary)] group-focus-within/repo:flex group-hover/repo:flex"
          >
            <SquareTerminal className="size-3.5" />
          </button>
        )}
      </div>
      {(worktrees.data ?? []).map((w) => (
        <WorktreeRow key={w.path} repo={repo} groupId={groupId} worktree={w} />
      ))}
    </>
  );
}

/**
 * The unified left sidebar ("Model C"): a flat terminal rail on top — every
 * open session across all groups, one move away — and the groups below as an
 * accordion holding their repos. One group is expanded at a time; selecting a
 * repo opens the repo workspace on the right.
 */
export function Sidebar() {
  const groups = useGroups();
  const repos = useRepos();
  const statuses = useRepoStatuses();
  const registerRepo = useRegisterRepo();
  const removeRepos = useRemoveRepos();
  const setRepoGroups = useSetRepoGroups();
  const fetchGroup = useFetchGroup();
  const showSyncedRoot = useSettings((s) => s.values.showSyncedRoot);

  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const setActiveGroup = useUiStore((s) => s.setActiveGroup);
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  const activeWorktreePath = useUiStore((s) => s.activeWorktreePath);
  const addTerminalTab = useUiStore((s) => s.addTerminalTab);
  const toggleSettings = useUiStore((s) => s.toggleSettings);
  const openRepoConfig = useUiStore((s) => s.openRepoConfig);
  const terminals = useUiStore((s) => s.terminals);
  const termActivity = useUiStore((s) => s.termActivity);

  const list = groups.data ?? [];
  const allRepos = repos.data ?? [];
  const statusById = new Map((statuses.data ?? []).map((s) => [s.id, s]));
  const defaultGroup = list.find((g) => g.is_default) ?? list[0];

  // Accordion state: which group's repos are shown. Follows the active group
  // (⌘1–9, palette, group memory) but can be collapsed independently.
  const [expandedId, setExpandedId] = useState<number | null>(activeGroupId);
  useEffect(() => {
    if (activeGroupId != null) setExpandedId(activeGroupId);
  }, [activeGroupId]);

  // Keep the active group valid, mirroring the old rail's fallback.
  const groupsData = groups.data;
  useEffect(() => {
    if (!groupsData || groupsData.length === 0) return;
    if (!groupsData.some((g) => g.id === activeGroupId)) {
      const fallback = groupsData.find((g) => g.is_default) ?? groupsData[0];
      setActiveGroup(fallback?.id ?? null);
    }
  }, [groupsData, activeGroupId, setActiveGroup]);

  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Repo[] | null>(null);
  const [folderOver, setFolderOver] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const [menu, setMenu] = useState<
    | { at: ContextMenuPosition; kind: "repo"; repo: Repo; groupId: number }
    | { at: ContextMenuPosition; kind: "group"; group: Group }
    | null
  >(null);

  const menuRepo = menu?.kind === "repo" ? menu.repo : null;
  const { data: remoteUrl } = useRepoRemoteUrl(
    menuRepo?.id ?? null,
    !!menuRepo && menuRepo.is_git_repo && !menuRepo.missing,
  );

  // Flat terminal rail: every open tab across all groups, in group order.
  const termEntries = list.flatMap((g) =>
    (terminals[g.id]?.tabs ?? []).map((tab) => ({ group: g, tab })),
  );

  // Root repos of folder-bound groups get hidden when the setting is off.
  const rootRepoIds = new Set(
    list.map((g) => g.root_repo_id).filter((id): id is number => id != null),
  );

  const activeGroup = list.find((g) => g.id === activeGroupId);
  const activeRepo = allRepos.find((r) => r.id === activeRepoId);
  // Where the "New terminal" button roots its shell: the selected worktree,
  // else the active repo, else the active group's bound folder.
  const newTermTarget = activeWorktreePath
    ? {
        path: activeWorktreePath,
        title: activeRepo ? activeRepo.name : basename(activeWorktreePath),
      }
    : activeRepo
      ? { path: activeRepo.path, title: activeRepo.name }
      : activeGroup?.folder_path
        ? { path: activeGroup.folder_path, title: activeGroup.name }
        : null;

  function groupRepos(g: Group): Repo[] {
    return visibleRepos(allRepos, g).filter((r) => showSyncedRoot || !rootRepoIds.has(r.id));
  }

  function toggleGroup(g: Group) {
    if (expandedId === g.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(g.id);
    setActiveGroup(g.id);
  }

  async function addRepo(group: Group) {
    const dir = await pickDirectory("Choose a folder");
    if (!dir) return;
    const repo = await registerRepo.mutateAsync(dir);
    if (!group.is_default) {
      setRepoGroups.mutate({ repoId: repo.id, groupIds: [group.id] });
    }
    setExpandedId(group.id);
    setActiveGroup(group.id);
  }

  // Register folders dropped from the OS file manager (into the active group).
  async function addDroppedFolders(paths: string[]) {
    const group = list.find((g) => g.id === activeGroupId);
    for (const path of paths) {
      try {
        const repo = await registerRepo.mutateAsync(path);
        if (group && !group.is_default) {
          setRepoGroups.mutate({ repoId: repo.id, groupIds: [group.id] });
        }
      } catch {
        // register_repo surfaces its own error toast; keep going with the rest.
      }
    }
  }
  const dropHandlerRef = useRef<(paths: string[]) => void>(() => {});
  dropHandlerRef.current = (paths) => void addDroppedFolders(paths);

  // Accept folders dropped from the OS file manager onto the sidebar. Native
  // drag-drop only exists inside the Tauri webview, so this is a no-op in a
  // plain browser (dev/tests). Scoped to the sidebar by hit-testing the drop
  // position (physical px → CSS px) against it.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const isOverSidebar = (px: number, py: number) => {
      const el = asideRef.current;
      if (!el) return false;
      const dpr = window.devicePixelRatio || 1;
      const x = px / dpr;
      const y = py / dpr;
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setFolderOver(isOverSidebar(p.position.x, p.position.y));
        } else if (p.type === "leave") {
          setFolderOver(false);
        } else if (p.type === "drop") {
          const inside = isOverSidebar(p.position.x, p.position.y);
          setFolderOver(false);
          if (inside && p.paths.length > 0) dropHandlerRef.current(p.paths);
        }
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const { data: dbHealth } = useQuery({ queryKey: ["db-health"], queryFn: ipc.dbHealth });

  return (
    <aside
      ref={asideRef}
      aria-label="Terminals and groups"
      className="relative flex h-full w-[280px] shrink-0 flex-col border-r"
      style={{ background: "var(--color-sidebar)", borderColor: "var(--color-sidebar-border)" }}
    >
      {folderOver && (
        <div className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-md border-2 border-dashed border-[var(--color-primary)] bg-[var(--color-primary)]/10">
          <span className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-foreground)] shadow">
            Drop to add repositories
          </span>
        </div>
      )}

      {/* ── Terminals ───────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3.5 pb-1.5 pt-3.5">
        <div className="text-[10.5px] font-bold uppercase tracking-[.13em] text-[var(--color-faint)]">
          Terminals
        </div>
        {termEntries.length > 0 && (
          <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--color-muted-foreground)]">
            <span
              aria-hidden
              className="size-1.5 rounded-full bg-[var(--color-primary)]"
              style={{ animation: "gamut-pulse 1.6s ease-in-out infinite" }}
            />
            {termEntries.length} open
          </div>
        )}
      </div>
      <div className="flex flex-col gap-px px-2">
        {termEntries.map(({ group, tab }) => (
          <TerminalRow key={`${group.id}:${tab.id}`} group={group} tab={tab} />
        ))}
        <button
          disabled={!newTermTarget}
          title={
            newTermTarget
              ? `New terminal in ${newTermTarget.title}`
              : "Select a repo or a folder-bound group first"
          }
          onClick={() => {
            if (!newTermTarget || activeGroupId == null) return;
            addTerminalTab(activeGroupId, newTermTarget.path, newTermTarget.title);
          }}
          className="mt-1 flex h-7 items-center gap-2 rounded-lg border border-dashed border-[var(--color-border)] px-2 text-[12.5px] font-medium text-[var(--color-muted-foreground)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] disabled:pointer-events-none disabled:opacity-50"
        >
          <Plus className="size-3.5" />
          New terminal
        </button>
      </div>

      <div className="mx-2.5 my-3 h-px bg-[var(--color-border)]" />

      {/* ── Groups ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3.5 pb-1.5">
        <div className="text-[10.5px] font-bold uppercase tracking-[.13em] text-[var(--color-faint)]">
          Groups
        </div>
        <span className="text-[10.5px] text-[var(--color-muted-foreground)]">
          {allRepos.length} repo{allRepos.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {list.map((g) => {
          const open = expandedId === g.id;
          const reposIn = groupRepos(g);
          const fetchableIds = reposIn.filter((r) => !r.missing && r.is_git_repo).map((r) => r.id);
          const Icon = g.icon ? GROUP_ICONS[g.icon] : null;
          const activity = groupActivityKind(terminals[g.id], termActivity);
          const running = (terminals[g.id]?.tabs.length ?? 0) > 0;
          return (
            <div key={g.id} className="flex flex-col">
              <div
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={() => toggleGroup(g)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleGroup(g);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ at: { x: e.clientX, y: e.clientY }, kind: "group", group: g });
                }}
                className={cn(
                  "group/grp flex min-h-8 cursor-pointer items-center gap-2 rounded-lg border border-transparent px-1.5 transition-colors",
                  g.id === activeGroupId
                    ? "border-[var(--color-border)] bg-[var(--color-card)]"
                    : "hover:bg-[var(--color-accent)]",
                )}
              >
                <ChevronRight
                  className={cn(
                    "size-3 shrink-0 text-[var(--color-faint)] transition-transform",
                    open && "rotate-90",
                  )}
                />
                <span className="flex size-4 shrink-0 items-center justify-center rounded bg-[var(--color-primary-soft)] text-[8px] font-bold text-[var(--color-primary)]">
                  {Icon ? <Icon className="size-3" /> : groupInitials(g.name)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-[var(--color-secondary-foreground)]">
                  {g.name}
                </span>
                <div className="flex items-center gap-1.5 pr-0.5 group-focus-within/grp:hidden group-hover/grp:hidden">
                  {activity && (
                    <span
                      aria-hidden
                      className="size-1.5 rounded-full"
                      style={{ background: activityColor(activity) }}
                    />
                  )}
                  {!activity && running && (
                    <span
                      aria-hidden
                      className="size-1.5 rounded-full bg-[var(--color-primary)]"
                      style={{ animation: "gamut-pulse 1.6s ease-in-out infinite" }}
                    />
                  )}
                  <span className="text-[11px] tabular-nums text-[var(--color-faint)]">
                    {reposIn.length}
                  </span>
                </div>
                {/* Revealed on focus-within too (the row is focusable), so
                    keyboard users can Tab into these once the row has focus. */}
                <div className="hidden items-center group-focus-within/grp:flex group-hover/grp:flex">
                  <button
                    aria-label={`Fetch all in ${g.name}`}
                    title="Fetch all repositories in this group"
                    disabled={fetchGroup.isPending || fetchableIds.length === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      fetchGroup.mutate(fetchableIds);
                    }}
                    className="flex size-5.5 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-secondary)] hover:text-[var(--color-primary)] disabled:pointer-events-none disabled:opacity-40"
                  >
                    {fetchGroup.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                  </button>
                  {g.folder_path && (
                    <button
                      aria-label={`New terminal in ${g.name}`}
                      title="New terminal in group folder"
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveGroup(g.id);
                        addTerminalTab(g.id, g.folder_path ?? "", g.name);
                      }}
                      className="flex size-5.5 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-secondary)] hover:text-[var(--color-primary)]"
                    >
                      <SquareTerminal className="size-3.5" />
                    </button>
                  )}
                  <button
                    aria-label={`Add repository to ${g.name}`}
                    title="Add repository"
                    onClick={(e) => {
                      e.stopPropagation();
                      void addRepo(g);
                    }}
                    className="flex size-5.5 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-secondary)] hover:text-[var(--color-primary)]"
                  >
                    <Plus className="size-3.5" />
                  </button>
                  <button
                    aria-label="Scan a folder for repositories"
                    title="Scan a folder for repositories"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveGroup(g.id);
                      setDiscoverOpen(true);
                    }}
                    className="flex size-5.5 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-secondary)] hover:text-[var(--color-primary)]"
                  >
                    <FolderSearch className="size-3.5" />
                  </button>
                </div>
              </div>

              {open && (
                <div className="mb-1.5 ml-[13px] mt-0.5 flex flex-col gap-px border-l border-[var(--color-border)] pl-2">
                  {reposIn.length === 0 ? (
                    <p className="px-2 py-2 text-[11px] text-[var(--color-faint)]">
                      No repositories. Use + on the group, or drop a folder here.
                    </p>
                  ) : (
                    reposIn.map((r) => (
                      <RepoRow
                        key={r.id}
                        repo={r}
                        groupId={g.id}
                        status={statusById.get(r.id)}
                        isSyncedRoot={rootRepoIds.has(r.id)}
                        onContextMenu={(e) =>
                          setMenu({
                            at: { x: e.clientX, y: e.clientY },
                            kind: "repo",
                            repo: r,
                            groupId: g.id,
                          })
                        }
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}

        <button
          onClick={() => {
            setEditingGroup(null);
            setGroupDialogOpen(true);
          }}
          className="mt-1 flex h-7 w-full items-center gap-2 rounded-lg px-1.5 text-[12px] font-medium text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
        >
          <Plus className="size-3.5" />
          New group
        </button>
      </div>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <div
        className="flex shrink-0 items-center gap-1 border-t px-2 py-1.5"
        style={{ borderColor: "var(--color-sidebar-border)" }}
      >
        <GitHubConnect />
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-muted-foreground)]">
          {dbHealth
            ? `db ok · ${dbHealth.migrations.length} migration${dbHealth.migrations.length === 1 ? "" : "s"}`
            : "connecting…"}
        </span>
        <button
          aria-label="Settings"
          title="Settings (⌘,)"
          onClick={toggleSettings}
          className="flex size-7 items-center justify-center rounded-md text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
        >
          <Settings className="size-4" />
        </button>
      </div>

      <DiscoverDialog open={discoverOpen} onOpenChange={setDiscoverOpen} />

      <GroupDialog
        group={editingGroup}
        open={groupDialogOpen}
        onOpenChange={setGroupDialogOpen}
        onCreated={(g) => {
          setActiveGroup(g.id);
          setExpandedId(g.id);
        }}
        onDeleted={() => setActiveGroup(defaultGroup?.id ?? null)}
      />

      <ConfirmRemoveReposDialog
        repos={removeTarget ?? []}
        hasRoot={removeTarget?.some((r) => rootRepoIds.has(r.id)) ?? false}
        open={removeTarget != null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        onConfirm={() => {
          if (removeTarget) removeRepos.mutate(removeTarget.map((r) => r.id));
          setRemoveTarget(null);
        }}
      />

      <ContextMenu at={menu?.at ?? null} onClose={() => setMenu(null)}>
        {menu?.kind === "repo" ? (
          <>
            {!menu.repo.missing && (
              <ContextMenuItem
                onClick={() => {
                  addTerminalTab(menu.groupId, menu.repo.path, menu.repo.name);
                  setMenu(null);
                }}
              >
                <SquareTerminal />
                Open terminal here
              </ContextMenuItem>
            )}
            <ContextMenuItem
              onClick={() => {
                void copy(menu.repo.path, "Copied path");
                setMenu(null);
              }}
            >
              <LinkIcon />
              Copy path
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                void copy(menu.repo.name, "Copied name");
                setMenu(null);
              }}
            >
              <Copy />
              Copy repo name
            </ContextMenuItem>
            {/* Config is git-only — a plain folder has no .git/config to show. */}
            {!menu.repo.missing && menu.repo.is_git_repo && (
              <ContextMenuItem
                onClick={() => {
                  openRepoConfig(menu.repo.id);
                  setMenu(null);
                }}
              >
                <Settings />
                Repo settings…
              </ContextMenuItem>
            )}
            {canAutoPull(menu.repo) && (
              <AutoPullMenuItem repo={menu.repo} onDone={() => setMenu(null)} />
            )}
            {remoteUrl && (
              <ContextMenuItem
                onClick={() => {
                  openUrl(remoteUrl).catch(() => {});
                  setMenu(null);
                }}
              >
                <Globe />
                Open remote repo
              </ContextMenuItem>
            )}
            <div className="my-1 border-t border-[var(--color-border)]" />
            <ContextMenuItem
              className="text-[var(--color-destructive)] [&_svg]:text-[var(--color-destructive)]"
              onClick={() => {
                setRemoveTarget([menu.repo]);
                setMenu(null);
              }}
            >
              <Trash2 />
              Remove repo
            </ContextMenuItem>
          </>
        ) : menu?.kind === "group" ? (
          <>
            {menu.group.folder_path ? (
              <ContextMenuItem
                onClick={() => {
                  setActiveGroup(menu.group.id);
                  addTerminalTab(menu.group.id, menu.group.folder_path ?? "", menu.group.name);
                  setMenu(null);
                }}
              >
                <SquareTerminal />
                Open terminal
              </ContextMenuItem>
            ) : (
              <div className="px-3 py-1.5 text-xs text-[var(--color-muted-foreground)]">
                Bind a folder to open a terminal
              </div>
            )}
            <ContextMenuItem
              onClick={() => {
                setEditingGroup(menu.group);
                setGroupDialogOpen(true);
                setMenu(null);
              }}
            >
              <Pencil />
              Edit group
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenu>
    </aside>
  );
}
