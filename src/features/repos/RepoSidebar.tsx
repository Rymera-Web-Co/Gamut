import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  AlertTriangle,
  Folder,
  FolderGit2,
  GitBranch,
  GripVertical,
  Link as LinkIcon,
  Loader2,
  Pencil,
  Plus,
  FolderSearch,
  RefreshCw,
  SquareTerminal,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuItem,
  type ContextMenuPosition,
} from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { copy } from "@/lib/clipboard";
import { BranchSwitcher } from "@/features/history/BranchSwitcher";
import { SyncControls } from "@/features/sync/SyncControls";
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
  useRemoveRepo,
  useReorderRepos,
  useRepoStatuses,
  useRepos,
  useSetRepoGroups,
} from "./api";
import { DiscoverDialog } from "./DiscoverDialog";
import { GroupDialog } from "./GroupDialog";

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
  const addTerminalTab = useUiStore((s) => s.addTerminalTab);
  const active = activeRepoId === repo.id && activeWorktreePath === worktree.path;
  const label = worktree.branch ?? worktree.path.split("/").filter(Boolean).pop() ?? worktree.path;

  return (
    <div
      role="button"
      tabIndex={0}
      title={worktree.missing ? "Checkout folder no longer exists on disk" : worktree.path}
      onClick={() => {
        if (worktree.missing) return;
        setActiveRepo(repo.id, worktree.path);
        ipc.touchRepo(repo.id);
      }}
      className={cn(
        "group/wt ml-6 flex cursor-pointer items-center gap-1.5 rounded-md border-l-2 py-1 pl-1.5 pr-1 text-xs",
        worktree.missing && "cursor-default opacity-60",
        active
          ? "border-l-[#2563eb] bg-[#2563eb]/15 font-medium text-[var(--color-foreground)]"
          : "border-l-transparent hover:bg-[var(--color-accent)]",
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
        <button
          aria-label="Open terminal here"
          title="Open terminal here"
          onClick={(e) => {
            e.stopPropagation();
            if (activeGroupId != null) {
              addTerminalTab(activeGroupId, worktree.path, `${repo.name} (${label})`);
            }
          }}
          className="shrink-0 opacity-0 transition-opacity hover:text-[var(--color-foreground)] group-hover/wt:opacity-100"
        >
          <SquareTerminal className="size-3.5 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]" />
        </button>
      )}
    </div>
  );
}

function RepoRow({
  repo,
  status,
  isSyncedRoot = false,
  onRemove,
  onReorder,
  onContextMenu,
}: {
  repo: Repo;
  status?: RepoStatus;
  isSyncedRoot?: boolean;
  onRemove: (repo: Repo) => void;
  onReorder: (srcId: number, targetId: number) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  const activeWorktreePath = useUiStore((s) => s.activeWorktreePath);
  const setActiveRepo = useUiStore((s) => s.setActiveRepo);
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const addTerminalTab = useUiStore((s) => s.addTerminalTab);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // A selected worktree highlights its own nested row, not the repo row.
  const active = activeRepoId === repo.id && activeWorktreePath == null;
  const worktrees = useLinkedWorktrees(repo.id, repo.is_git_repo && !repo.missing);

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
        {...drag}
        onClick={() => {
          setActiveRepo(repo.id);
          ipc.touchRepo(repo.id);
        }}
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
          active
            ? "border-l-[#2563eb] bg-[#2563eb]/15 font-medium text-[var(--color-foreground)]"
            : "border-l-transparent hover:bg-[var(--color-accent)]",
        )}
      >
        <GripVertical className="mt-0.5 size-3.5 shrink-0 cursor-grab text-[var(--color-muted-foreground)] opacity-0 group-hover:opacity-60" />
        {repo.missing ? (
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-[var(--color-destructive)]"
            aria-label="Folder no longer exists"
          >
            <title>Folder no longer exists on disk</title>
          </AlertTriangle>
        ) : repo.is_git_repo ? (
          <FolderGit2
            className={cn(
              "mt-0.5 size-4 shrink-0",
              active ? "text-[#2563eb]" : "text-[var(--color-muted-foreground)]",
            )}
          />
        ) : (
          <Folder
            className={cn(
              "mt-0.5 size-4 shrink-0",
              active ? "text-[#2563eb]" : "text-[var(--color-muted-foreground)]",
            )}
            aria-label="Not a git repository"
          >
            <title>Not a git repository</title>
          </Folder>
        )}
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
              <button
                aria-label="Open terminal here"
                title="Open terminal here"
                // Don't let a press on this button arm a repo drag on the row.
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (activeGroupId != null) {
                    addTerminalTab(activeGroupId, repo.path, repo.name);
                  }
                }}
                className="shrink-0 opacity-0 transition-opacity hover:text-[var(--color-foreground)] group-hover:opacity-100"
              >
                <SquareTerminal className="size-3.5 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]" />
              </button>
            )}
            <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
              <PopoverTrigger asChild>
                <button
                  aria-label="Remove repository"
                  title="Remove from Gamut"
                  // Don't let a press on this button arm a repo drag on the row.
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    "shrink-0 transition-opacity hover:text-[var(--color-destructive)] group-hover:opacity-100",
                    confirmOpen ? "opacity-100" : "opacity-0",
                  )}
                >
                  <Trash2 className="size-3.5 text-[var(--color-muted-foreground)] hover:text-[var(--color-destructive)]" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                side="bottom"
                className="w-64 p-3"
                onClick={(e) => e.stopPropagation()}
              >
                <p className="text-sm text-[var(--color-muted-foreground)]">
                  Remove{" "}
                  <span className="font-medium text-[var(--color-foreground)]">{repo.name}</span>{" "}
                  from Gamut? This only removes it from the list — your files on disk are not
                  touched.
                </p>
                <div className="mt-3 flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => setConfirmOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      setConfirmOpen(false);
                      onRemove(repo);
                    }}
                  >
                    <Trash2 /> Remove
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
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
  const removeRepo = useRemoveRepo();
  const setRepoGroups = useSetRepoGroups();
  const reorderRepos = useReorderRepos();
  const fetchGroup = useFetchGroup();
  const statuses = useRepoStatuses();
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const setActiveGroup = useUiStore((s) => s.setActiveGroup);
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

  // Repos eligible for a group fetch — everything visible except missing folders
  // (fetching a gone directory just errors) and non-git folders (nothing to
  // fetch).
  const fetchableIds = visible.filter((r) => !r.missing && r.is_git_repo).map((r) => r.id);

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
                onRemove={(repo) => removeRepo.mutate(repo.id)}
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
                    onRemove={(repo) => removeRepo.mutate(repo.id)}
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
            <div className="my-1 border-t border-[var(--color-border)]" />
            <ContextMenuItem
              className="text-[var(--color-destructive)] [&_svg]:text-[var(--color-destructive)]"
              onClick={() => {
                const repo = menu.repo;
                setMenu(null);
                if (
                  window.confirm(
                    `Remove "${repo.name}" from Gamut? This only removes it from the list — your files on disk are not touched.`,
                  )
                ) {
                  removeRepo.mutate(repo.id);
                }
              }}
            >
              <Trash2 />
              Remove repo
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
