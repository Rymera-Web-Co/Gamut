import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Copy,
  Folder,
  FolderGit2,
  GitBranch,
  Globe,
  GripVertical,
  Link as LinkIcon,
  Loader2,
  Pencil,
  Plus,
  FolderSearch,
  RefreshCw,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuItem,
  type ContextMenuPosition,
} from "@/components/ui/context-menu";
import { canAutoPull } from "@/lib/autoPull";
import { copy } from "@/lib/clipboard";
import { BranchSwitcher } from "@/features/history/BranchSwitcher";
import { SyncControls } from "@/features/sync/SyncControls";
import { usePullMany, usePushMany } from "@/features/sync/useSyncMany";
import { moveBefore } from "@/lib/dnd";
import { useDraggable, useDropTarget } from "@/lib/usePointerDnd";
import { visibleRepos } from "@/lib/groupRepos";
import { ipc, pickDirectory, type LinkedWorktree, type Repo, type RepoStatus } from "@/lib/ipc";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/ui";
import {
  useFetchGroup,
  useGroups,
  useLinkedWorktrees,
  useRegisterRepo,
  useRemoveRepos,
  useReorderRepos,
  useRepoRemoteUrl,
  useRepoStatuses,
  useRepos,
  useSetRepoGroups,
} from "./api";
import { AutoPullMenuItem } from "./AutoPullMenuItem";
import { ConfirmRemoveReposDialog } from "./ConfirmRemoveReposDialog";
import { DiscoverDialog } from "./DiscoverDialog";
import { GroupDialog } from "./GroupDialog";
import { rangeIds } from "./repoSelection";

// Shared active/inactive styling for the selectable rows (repo + worktree) so
// the highlight treatment stays in lockstep between them.
function getActiveRowClass(active: boolean) {
  return active
    ? "border-l-[#2563eb] bg-[#2563eb]/15 font-medium text-[var(--color-foreground)]"
    : "border-l-transparent hover:bg-[var(--color-accent)]";
}

/**
 * The "open terminal here" button shared by repo and worktree rows. Roots a new
 * terminal tab at `path` in the active group, titled `tabTitle`. `className`
 * carries the row-specific hover group (`group-hover` vs `group-hover/wt`), and
 * `onPointerDown` lets a row suppress a drag arming when the button is pressed.
 */
function TerminalButton({
  groupId,
  path,
  tabTitle,
  className,
  onPointerDown,
}: {
  groupId: number | null;
  path: string;
  tabTitle: string;
  className?: string;
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  const addTerminalTab = useUiStore((s) => s.addTerminalTab);
  return (
    <button
      aria-label="Open terminal here"
      title="Open terminal here"
      onPointerDown={onPointerDown}
      onClick={(e) => {
        e.stopPropagation();
        if (groupId != null) addTerminalTab(groupId, path, tabTitle);
      }}
      className={cn(
        "shrink-0 opacity-0 transition-opacity hover:text-[var(--color-foreground)]",
        className,
      )}
    >
      <SquareTerminal className="size-3.5 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]" />
    </button>
  );
}

/**
 * One linked worktree, nested under its repo's row. Selecting it keeps the
 * repo active for the content views but roots new terminals at the worktree's
 * checkout; the terminal button opens one there directly.
 */
function WorktreeRow({ repo, worktree }: { repo: Repo; worktree: LinkedWorktree }) {
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  const activeWorktreePath = useUiStore((s) => s.activeWorktreePath);
  const setActiveRepo = useUiStore((s) => s.setActiveRepo);
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const active = activeRepoId === repo.id && activeWorktreePath === worktree.path;
  // Fall back to the checkout's folder name when detached; split on both
  // separators so a Windows path (`\`) yields the folder, not the whole path.
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
        "group/wt ml-6 flex cursor-pointer items-center gap-1.5 rounded-md border-l-2 py-1 pl-1.5 pr-1 text-xs",
        worktree.missing && "cursor-default opacity-60",
        getActiveRowClass(active),
      )}
    >
      {worktree.missing ? (
        <AlertTriangle className="size-3.5 shrink-0 text-[var(--color-destructive)]" />
      ) : (
        <GitBranch
          className={cn(
            "size-3.5 shrink-0",
            active ? "text-[#2563eb]" : "text-[var(--color-muted-foreground)]",
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
      {!worktree.missing && (
        <TerminalButton
          groupId={activeGroupId}
          path={worktree.path}
          tabTitle={`${repo.name} (${label})`}
          className="group-hover/wt:opacity-100"
        />
      )}
    </div>
  );
}

function RepoRow({
  repo,
  status,
  isSyncedRoot = false,
  selected,
  onRowClick,
  onToggleSelect,
  onRequestRemove,
  onReorder,
  onContextMenu,
}: {
  repo: Repo;
  status?: RepoStatus;
  isSyncedRoot?: boolean;
  /** Whether this row is part of the current multi-selection (⌘/Ctrl-click,
   * ⇧-click range, or the hover checkbox) — distinct from "active". */
  selected: boolean;
  onRowClick: (repo: Repo, e: React.MouseEvent) => void;
  onToggleSelect: (repo: Repo) => void;
  onRequestRemove: (repo: Repo) => void;
  onReorder: (srcId: number, targetId: number) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  const activeWorktreePath = useUiStore((s) => s.activeWorktreePath);
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  // A selected worktree highlights its own nested row, not the repo row.
  const active = activeRepoId === repo.id && activeWorktreePath == null;
  // Only run `git worktree list` for repos that actually have linked worktrees.
  // The live status flag wins once loaded; the persisted repo flag gates it
  // before the first status scan. This keeps opening a group from spawning a
  // git subprocess per repo when almost none have worktrees.
  const hasWorktrees = status?.has_worktrees ?? repo.has_worktrees;
  const worktrees = useLinkedWorktrees(repo.id, repo.is_git_repo && !repo.missing && hasWorktrees);

  const drag = useDraggable({ kind: "repo", id: repo.id }, repo.name);
  const { ref: dropRef, state: dropOver } = useDropTarget<boolean, HTMLDivElement>({
    accepts: (d) => d.kind === "repo" && d.id !== repo.id,
    compute: () => true,
    onDrop: (d) => {
      if (d.kind === "repo") onReorder(d.id, repo.id);
    },
  });

  return (
    <>
      <div
        ref={dropRef}
        role="button"
        tabIndex={0}
        title={repo.path}
        aria-selected={selected}
        {...drag}
        onClick={(e) => onRowClick(repo, e)}
        onContextMenu={(e) => {
          // Suppress the native webview menu, and keep the row's menu from also
          // firing the sidebar blank-space menu.
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e);
        }}
        className={cn(
          "group flex cursor-pointer items-start gap-1.5 rounded-md border-l-2 px-1 py-1.5 text-sm",
          dropOver && "border-t-2 border-t-[var(--color-primary)]",
          repo.missing && "opacity-60",
          getActiveRowClass(active),
          // A ring, not a background: the active row already owns a background
          // (`getActiveRowClass`), and two competing `bg-*` utilities would let
          // one silently win — so a row that is both active and selected would
          // lose one of the two signals. Same reasoning as `RepoTree.tsx`.
          selected && "ring-1 ring-inset ring-[var(--color-primary)]",
        )}
      >
        <GripVertical className="mt-0.5 size-3.5 shrink-0 cursor-grab text-[var(--color-muted-foreground)] opacity-0 group-hover:opacity-60" />
        {/* The leading icon and the selection checkbox share one fixed-size slot
            (both absolutely positioned inside it) so hover/selection swaps one
            for the other without shifting the row. */}
        <div className="relative mt-0.5 size-4 shrink-0">
          <span
            className={cn(
              "absolute inset-0 transition-opacity",
              "group-hover:opacity-0",
              selected && "opacity-0",
            )}
          >
            {repo.missing ? (
              <AlertTriangle
                className="size-4 text-[var(--color-destructive)]"
                aria-label="Folder no longer exists"
              >
                <title>Folder no longer exists on disk</title>
              </AlertTriangle>
            ) : repo.is_git_repo ? (
              <FolderGit2
                className={cn(
                  "size-4",
                  active ? "text-[#2563eb]" : "text-[var(--color-muted-foreground)]",
                )}
              />
            ) : (
              <Folder
                className={cn(
                  "size-4",
                  active ? "text-[#2563eb]" : "text-[var(--color-muted-foreground)]",
                )}
                aria-label="Not a git repository"
              >
                <title>Not a git repository</title>
              </Folder>
            )}
          </span>
          <input
            type="checkbox"
            aria-label={`Select ${repo.name}`}
            checked={selected}
            onChange={() => onToggleSelect(repo)}
            onClick={(e) => e.stopPropagation()}
            // Don't let a press on the checkbox arm a repo drag on the row.
            onPointerDown={(e) => e.stopPropagation()}
            className={cn(
              "absolute inset-0 size-4 cursor-pointer opacity-0 transition-opacity",
              "group-hover:opacity-100",
              selected && "opacity-100",
            )}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-1">
            <span
              className={cn(
                "min-w-0 flex-1 truncate leading-tight",
                repo.missing && "line-through decoration-[var(--color-destructive)]/60",
              )}
              title={repo.missing ? "Folder no longer exists on disk" : undefined}
            >
              {repo.name}
            </span>
            {isSyncedRoot && (
              <span
                title="This group’s synced folder (root)"
                className="shrink-0 rounded bg-[var(--color-primary)]/15 px-1 py-px text-[9px] font-semibold uppercase leading-tight tracking-wide text-[var(--color-primary)]"
              >
                root
              </span>
            )}
            {!repo.missing && repo.is_git_repo && status?.has_uncommitted_changes && (
              <span
                aria-label="Uncommitted changes"
                title="Uncommitted changes"
                className="mt-0.5 size-2 shrink-0 rounded-full bg-[#f59e0b]"
              />
            )}
            {!repo.missing && (
              <TerminalButton
                groupId={activeGroupId}
                path={repo.path}
                tabTitle={repo.name}
                className="group-hover:opacity-100"
                // Don't let a press on this button arm a repo drag on the row.
                onPointerDown={(e) => e.stopPropagation()}
              />
            )}
            <button
              aria-label="Remove repository"
              title="Remove from Gamut"
              // Don't let a press on this button arm a repo drag on the row.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onRequestRemove(repo);
              }}
              className="shrink-0 opacity-0 transition-opacity hover:text-[var(--color-destructive)] group-hover:opacity-100"
            >
              <Trash2 className="size-3.5 text-[var(--color-muted-foreground)] hover:text-[var(--color-destructive)]" />
            </button>
          </div>
          {/* Per-repo branch switcher + sync controls (manage without selecting).
            Non-git folders have no branch or upstream, so neither is shown. */}
          {repo.is_git_repo && (
            <div
              className="flex w-fit items-center gap-0.5"
              onClick={(e) => e.stopPropagation()}
              // Don't let a press on the branch/sync controls start a repo drag.
              onPointerDown={(e) => e.stopPropagation()}
            >
              <BranchSwitcher repoId={repo.id} currentBranch={status?.branch} />
              <SyncControls repoId={repo.id} ahead={status?.ahead} behind={status?.behind} />
            </div>
          )}
        </div>
      </div>
      {(worktrees.data ?? []).map((w) => (
        <WorktreeRow key={w.path} repo={repo} worktree={w} />
      ))}
    </>
  );
}

export function RepoSidebar() {
  const repos = useRepos();
  const groups = useGroups();
  const registerRepo = useRegisterRepo();
  const removeRepos = useRemoveRepos();
  const setRepoGroups = useSetRepoGroups();
  const reorderRepos = useReorderRepos();
  const fetchGroup = useFetchGroup();
  const pullMany = usePullMany();
  const pushMany = usePushMany();
  const statuses = useRepoStatuses();
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const setActiveGroup = useUiStore((s) => s.setActiveGroup);
  const setActiveRepo = useUiStore((s) => s.setActiveRepo);
  const addTerminalTab = useUiStore((s) => s.addTerminalTab);
  const showSyncedRoot = useSettings((s) => s.values.showSyncedRoot);

  const statusById = new Map((statuses.data ?? []).map((s) => [s.id, s]));

  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [editGroupOpen, setEditGroupOpen] = useState(false);
  // A folder is being dragged from the OS file manager over the sidebar.
  const [folderOver, setFolderOver] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  // Right-click menus: on a repo row, or on the sidebar's blank space.
  const [menu, setMenu] = useState<
    | { at: ContextMenuPosition; kind: "repo"; repo: Repo }
    | { at: ContextMenuPosition; kind: "blank" }
    | null
  >(null);

  // Multi-selection (⌘/Ctrl-click toggle, ⇧-click range) over the rendered repo
  // rows. Local component state, not the global store — mirrors
  // `RepoTree.tsx`'s `selectedPaths`/`anchor`. `anchor` is the row a ⇧-range
  // extends from, in rendered order.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  // The repos pending the bulk-remove confirmation dialog (single-row trash
  // target or the whole selection); null when the dialog is closed. Holds the
  // `Repo` rows themselves, not their ids: the dialog renders this exact array
  // and `confirmRemove` sends its ids, so the set removed can never differ from
  // the set the user was shown — even if the repo list refetches, or the active
  // group is switched by a keyboard shortcut, while the dialog is open.
  const [removeTarget, setRemoveTarget] = useState<Repo[] | null>(null);

  // "Open remote repo" only makes sense for a present git repo, and is hidden
  // unless the origin remote resolves — so resolve it lazily for the repo the
  // context menu is currently open on.
  const menuRepo = menu?.kind === "repo" ? menu.repo : null;
  const { data: remoteUrl } = useRepoRemoteUrl(
    menuRepo?.id ?? null,
    !!menuRepo && menuRepo.is_git_repo && !menuRepo.missing,
  );

  const allRepos = repos.data ?? [];
  const allGroups = groups.data ?? [];
  const activeGroup = allGroups.find((g) => g.id === activeGroupId);
  const defaultGroup = allGroups.find((g) => g.is_default) ?? allGroups[0];
  // A folder-bound group can open a terminal at its parent directory — useful
  // for operating across all the repos under that folder at once.
  const groupFolder = activeGroup?.folder_path ?? null;

  // Repos that are the synced root of a folder-bound group. Tagged with a "root"
  // badge to set them apart from discovered subfolders, and hidden entirely when
  // the user turns the setting off (they stay registered, just not listed).
  const rootRepoIds = new Set(
    allGroups.map((g) => g.root_repo_id).filter((id): id is number => id != null),
  );

  const visible = visibleRepos(allRepos, activeGroup).filter(
    (r) => showSyncedRoot || !rootRepoIds.has(r.id),
  );
  // Non-git folders are shown in their own section at the bottom, kept apart
  // from real repos (they have no branch/sync and only a Files tab).
  const gitRepos = visible.filter((r) => r.is_git_repo);
  const nonGitRepos = visible.filter((r) => !r.is_git_repo);
  // The exact on-screen row order across the git-repos / Folders section
  // boundary — what a ⇧-range follows.
  const orderedIds = [...gitRepos, ...nonGitRepos].map((r) => r.id);

  // Repos eligible for a group fetch — everything visible except missing folders
  // (fetching a gone directory just errors) and non-git folders (nothing to
  // fetch).
  const fetchableIds = visible.filter((r) => !r.missing && r.is_git_repo).map((r) => r.id);
  // The selected rows, in rendered order. Drawn from `visible`, so an id that has
  // left the on-screen list can never reach a bulk action.
  const selectedRepos = visible.filter((r) => selectedIds.has(r.id));
  // The same eligibility, narrowed to the selection — what the bulk bar's pull
  // and push act on, so their tooltips state what will actually run.
  const selectedSyncableIds = fetchableIds.filter((id) => selectedIds.has(id));
  // One in-flight bulk sync at a time: pulling and pushing the same repos at
  // once would race on the same working trees.
  const syncBusy = pullMany.isPending || pushMany.isPending;
  // Whether the selection covers every row on screen (drives the bar's select-all
  // checkbox; anything less shows as indeterminate).
  const allVisibleSelected = orderedIds.length > 0 && selectedIds.size === orderedIds.length;

  // Switching groups shows a different set of rows entirely — carrying a
  // selection across that switch would let a hidden id get bulk-removed. The
  // pending dialog target goes too: a group switch is reachable *while the
  // dialog is open* (the ⌘/Ctrl+1…9 and Ctrl+Tab bindings are a window keydown
  // listener that Radix's overlay doesn't intercept), and confirming against a
  // group the user is no longer looking at would remove rows they can't see.
  useEffect(() => {
    setSelectedIds(new Set());
    setAnchor(null);
    setRemoveTarget(null);
  }, [activeGroupId]);

  // Drop ids that leave the visible set (reassigned to another group, or
  // removed by some other path) so a later bulk action can't target a repo
  // that no longer shows on screen. Keyed on the id list rather than the
  // `visible` array, which is rebuilt every render.
  const visibleIdKey = orderedIds.join(",");
  useEffect(() => {
    const ids = new Set(visibleIdKey ? visibleIdKey.split(",").map(Number) : []);
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleIdKey]);

  function clearSelection() {
    setSelectedIds(new Set());
    setAnchor(null);
  }

  function toggleSelect(repo: Repo) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(repo.id)) next.delete(repo.id);
      else next.add(repo.id);
      return next;
    });
    setAnchor(repo.id);
  }

  // Resolve a row click against its modifiers: ⌘/Ctrl toggles the row in/out of
  // the selection, ⇧ selects the inclusive range from the anchor (in rendered
  // order), and a plain click clears the selection and activates the repo —
  // today's behavior, unchanged.
  function handleRowClick(repo: Repo, e: React.MouseEvent) {
    if (e.metaKey || e.ctrlKey) {
      toggleSelect(repo);
      return;
    }
    if (e.shiftKey) {
      const from = anchor ?? repo.id;
      setSelectedIds(new Set(rangeIds(orderedIds, from, repo.id)));
      setAnchor((a) => a ?? repo.id);
      return;
    }
    setSelectedIds(new Set());
    setAnchor(repo.id);
    setActiveRepo(repo.id);
    ipc.touchRepo(repo.id);
  }

  // What a remove action on `repo` targets: the whole selection when `repo` is
  // part of it, else just that row. Shared by the trash icon and the context
  // menu so the two can't scope differently. Drawn from `visible`, so an id that
  // has left the on-screen list can never end up in the dialog.
  function removeTargetFor(repo: Repo): Repo[] {
    return selectedIds.has(repo.id) ? selectedRepos : [repo];
  }

  // What the open context menu's remove item would target — drives its label.
  const menuRemoveTarget = menuRepo ? removeTargetFor(menuRepo) : [];

  function confirmRemove() {
    if (!removeTarget) return;
    removeRepos.mutate(removeTarget.map((r) => r.id));
    clearSelection();
    setRemoveTarget(null);
  }

  function reorder(srcId: number, targetId: number) {
    const order = moveBefore(
      visible.map((r) => r.id),
      srcId,
      targetId,
    );
    reorderRepos.mutate(order);
  }

  async function addRepo() {
    const dir = await pickDirectory("Choose a folder");
    if (!dir) return;
    const repo = await registerRepo.mutateAsync(dir);
    // Add the new repo to the active (non-default) group so it shows up here.
    if (activeGroupId != null && activeGroup && !activeGroup.is_default) {
      setRepoGroups.mutate({ repoId: repo.id, groupIds: [activeGroupId] });
    }
  }

  // Register one or more folders dropped from the OS file manager, reusing the
  // same path (register_repo classifies git/non-git and dedupes already-added
  // paths) and active-group assignment as the picker `addRepo` above.
  async function addDroppedFolders(paths: string[]) {
    for (const path of paths) {
      try {
        const repo = await registerRepo.mutateAsync(path);
        if (activeGroupId != null && activeGroup && !activeGroup.is_default) {
          setRepoGroups.mutate({ repoId: repo.id, groupIds: [activeGroupId] });
        }
      } catch {
        // register_repo surfaces its own error toast; keep going with the rest.
      }
    }
  }

  // Keep the drop handler current without re-binding the native listener below.
  const dropHandlerRef = useRef<(paths: string[]) => void>(() => {});
  dropHandlerRef.current = (paths) => void addDroppedFolders(paths);

  // Accept folders dropped from the OS file manager onto the sidebar. Native
  // drag-drop only exists inside the Tauri webview, so this is a no-op in a
  // plain browser (dev/tests). The one webview-wide listener is scoped to the
  // sidebar by hit-testing the drop position (physical px → CSS px) against it.
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

  return (
    <aside
      ref={asideRef}
      className="relative flex h-full w-full flex-col"
      style={{ background: "var(--color-sidebar)" }}
    >
      {folderOver && (
        <div className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-md border-2 border-dashed border-[var(--color-primary)] bg-[var(--color-primary)]/10">
          <span className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-foreground)] shadow">
            Drop to add repositories
          </span>
        </div>
      )}
      {/* With rows selected, the header turns into a bulk-action bar: the group
          name and its per-group controls have nothing to do with the selection,
          and acting on it is what the user is mid-way through. Same height and
          border as the normal header so the swap doesn't move the list. */}
      {selectedIds.size > 0 ? (
        <header
          role="toolbar"
          aria-label="Bulk actions for selected repositories"
          className="flex h-10 shrink-0 items-center justify-between gap-1 border-b bg-[var(--color-accent)] px-3"
        >
          <label className="flex min-w-0 cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              aria-label={allVisibleSelected ? "Deselect all" : "Select all"}
              checked={allVisibleSelected}
              ref={(el) => {
                // Partial selection reads as indeterminate — settable only from
                // script, never from an attribute.
                if (el) el.indeterminate = !allVisibleSelected;
              }}
              onChange={() => setSelectedIds(allVisibleSelected ? new Set() : new Set(orderedIds))}
            />
            <span className="min-w-0 truncate text-xs font-semibold text-[var(--color-foreground)]">
              {selectedIds.size} selected
            </span>
          </label>
          {/* Icon-only so the whole bar fits a narrow sidebar — the count lives
              in the label on the left, and each action names itself through its
              tooltip and accessible label. Pull/push act on the syncable subset
              (a missing or non-git folder has nothing to sync), so the tooltip
              states the number that will actually run. Fetching stays a
              group-level action: the header's fetch button already covers the
              whole group, so a per-selection fetch would be redundant. */}
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label="Clear selection"
              title="Clear selection"
              onClick={clearSelection}
            >
              <X />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={`Pull ${selectedSyncableIds.length} selected`}
              title={`Pull ${selectedSyncableIds.length} selected`}
              disabled={syncBusy || selectedSyncableIds.length === 0}
              onClick={() => pullMany.mutate(selectedSyncableIds)}
            >
              {pullMany.isPending ? <Loader2 className="animate-spin" /> : <ArrowDownToLine />}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={`Push ${selectedSyncableIds.length} selected`}
              title={`Push ${selectedSyncableIds.length} selected`}
              disabled={syncBusy || selectedSyncableIds.length === 0}
              onClick={() => pushMany.mutate(selectedSyncableIds)}
            >
              {pushMany.isPending ? <Loader2 className="animate-spin" /> : <ArrowUpFromLine />}
            </Button>
            <Button
              size="icon"
              variant="destructive"
              className="size-7"
              aria-label={`Remove ${selectedIds.size} selected`}
              title={`Remove ${selectedIds.size} selected from Gamut`}
              onClick={() => setRemoveTarget(selectedRepos)}
            >
              <Trash2 />
            </Button>
          </div>
        </header>
      ) : (
        <header className="flex h-10 shrink-0 items-center justify-between gap-1 border-b px-3">
          <div className="group flex min-w-0 items-center gap-1">
            <span
              className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]"
              title={activeGroup?.name}
            >
              {activeGroup?.name ?? "Repositories"}
            </span>
            {activeGroup && (
              <button
                aria-label={`Edit ${activeGroup.name}`}
                title="Edit group"
                onClick={() => setEditGroupOpen(true)}
                className="shrink-0 opacity-0 transition-opacity hover:text-[var(--color-foreground)] group-hover:opacity-100"
              >
                <Pencil className="size-3 text-[var(--color-muted-foreground)]" />
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center">
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              title="Fetch all repositories in this group (⌘⌥F)"
              disabled={fetchGroup.isPending || fetchableIds.length === 0}
              onClick={() => fetchGroup.mutate(fetchableIds)}
            >
              {fetchGroup.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            </Button>
            {groupFolder && activeGroup && (
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                title={`Open terminal at ${activeGroup.name} folder`}
                onClick={() => addTerminalTab(activeGroup.id, groupFolder, activeGroup.name)}
              >
                <SquareTerminal />
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              title="Add repository"
              onClick={addRepo}
            >
              <Plus />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              title="Scan a folder for repositories"
              onClick={() => setDiscoverOpen(true)}
            >
              <FolderSearch />
            </Button>
          </div>
        </header>
      )}

      <div
        className="min-h-0 flex-1 overflow-auto p-2"
        onContextMenu={(e) => {
          // Repo rows stop propagation, so only the blank area reaches here.
          e.preventDefault();
          setMenu({ at: { x: e.clientX, y: e.clientY }, kind: "blank" });
        }}
      >
        {visible.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-[var(--color-muted-foreground)]">
            {allRepos.length === 0
              ? "No repositories yet. Use + or scan a folder."
              : "No repositories in this group. Use + to add one, or drag a repo onto this group."}
          </p>
        ) : (
          <>
            {gitRepos.map((r) => (
              <RepoRow
                key={r.id}
                repo={r}
                status={statusById.get(r.id)}
                isSyncedRoot={rootRepoIds.has(r.id)}
                selected={selectedIds.has(r.id)}
                onRowClick={handleRowClick}
                onToggleSelect={toggleSelect}
                onRequestRemove={(repo) => setRemoveTarget(removeTargetFor(repo))}
                onReorder={reorder}
                onContextMenu={(e) =>
                  setMenu({ at: { x: e.clientX, y: e.clientY }, kind: "repo", repo: r })
                }
              />
            ))}
            {nonGitRepos.length > 0 && (
              <>
                {gitRepos.length > 0 && (
                  <div className="mb-1 mt-3 px-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
                    Folders
                  </div>
                )}
                {nonGitRepos.map((r) => (
                  <RepoRow
                    key={r.id}
                    repo={r}
                    status={statusById.get(r.id)}
                    isSyncedRoot={rootRepoIds.has(r.id)}
                    selected={selectedIds.has(r.id)}
                    onRowClick={handleRowClick}
                    onToggleSelect={toggleSelect}
                    onRequestRemove={(repo) => setRemoveTarget(removeTargetFor(repo))}
                    onReorder={reorder}
                    onContextMenu={(e) =>
                      setMenu({ at: { x: e.clientX, y: e.clientY }, kind: "repo", repo: r })
                    }
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>

      <DiscoverDialog open={discoverOpen} onOpenChange={setDiscoverOpen} />

      <GroupDialog
        group={activeGroup ?? null}
        open={editGroupOpen}
        onOpenChange={setEditGroupOpen}
        onDeleted={() => setActiveGroup(defaultGroup?.id ?? null)}
      />

      <ConfirmRemoveReposDialog
        repos={removeTarget ?? []}
        hasRoot={removeTarget?.some((r) => rootRepoIds.has(r.id)) ?? false}
        open={removeTarget != null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        onConfirm={confirmRemove}
      />

      <ContextMenu at={menu?.at ?? null} onClose={() => setMenu(null)}>
        {menu?.kind === "repo" ? (
          <>
            {/* A terminal opens in the active group; with no active group the
                action would be a no-op, so hide the item rather than show a
                dead entry. */}
            {!menu.repo.missing && activeGroupId != null && (
              <ContextMenuItem
                onClick={() => {
                  addTerminalTab(activeGroupId, menu.repo.path, menu.repo.name);
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
            {/* Hidden for plain folders and missing repos — see canAutoPull. */}
            {canAutoPull(menu.repo) && (
              <AutoPullMenuItem repo={menu.repo} onDone={() => setMenu(null)} />
            )}
            {/* Hidden unless the repo has a resolvable origin remote (see the
                useRepoRemoteUrl call above), matching how "Open terminal here"
                hides rather than showing a dead entry. */}
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
                setMenu(null);
                setRemoveTarget(removeTargetFor(menu.repo));
              }}
            >
              <Trash2 />
              {menuRemoveTarget.length > 1
                ? `Remove ${menuRemoveTarget.length} repository folders`
                : "Remove repo"}
            </ContextMenuItem>
          </>
        ) : menu?.kind === "blank" ? (
          <>
            <ContextMenuItem
              onClick={() => {
                setMenu(null);
                void addRepo();
              }}
            >
              <Plus />
              Add repo
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                setMenu(null);
                setDiscoverOpen(true);
              }}
            >
              <FolderSearch />
              Discover repos
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenu>
    </aside>
  );
}
