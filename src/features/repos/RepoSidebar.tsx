import { useState } from "react";
import {
  AlertTriangle,
  Folder,
  FolderGit2,
  GripVertical,
  Loader2,
  Pencil,
  Plus,
  FolderSearch,
  RefreshCw,
  SquareTerminal,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BranchSwitcher } from "@/features/history/BranchSwitcher";
import { SyncControls } from "@/features/sync/SyncControls";
import { clearDrag, getDrag, moveBefore, setDrag } from "@/lib/dnd";
import { visibleRepos } from "@/lib/groupRepos";
import { ipc, pickDirectory, type Repo, type RepoStatus } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/ui";
import {
  useFetchGroup,
  useGroups,
  useRegisterRepo,
  useRemoveRepo,
  useReorderRepos,
  useRepoStatuses,
  useRepos,
  useSetRepoGroups,
} from "./api";
import { DiscoverDialog } from "./DiscoverDialog";
import { GroupDialog } from "./GroupDialog";

function RepoRow({
  repo,
  status,
  onRemove,
  onReorder,
}: {
  repo: Repo;
  status?: RepoStatus;
  onRemove: (repo: Repo) => void;
  onReorder: (srcId: number, targetId: number) => void;
}) {
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  const setActiveRepo = useUiStore((s) => s.setActiveRepo);
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const addTerminalTab = useUiStore((s) => s.addTerminalTab);
  const [dropOver, setDropOver] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const active = activeRepoId === repo.id;

  return (
    <div
      role="button"
      tabIndex={0}
      title={repo.path}
      draggable
      onDragStart={(e) => {
        setDrag({ kind: "repo", id: repo.id });
        e.dataTransfer.setData("text/plain", repo.name);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => {
        clearDrag();
        setDropOver(false);
      }}
      onDragOver={(e) => {
        const d = getDrag();
        if (d?.kind === "repo" && d.id !== repo.id) {
          e.preventDefault();
          setDropOver(true);
        }
      }}
      onDragLeave={() => setDropOver(false)}
      onDrop={(e) => {
        setDropOver(false);
        const d = getDrag();
        if (d?.kind !== "repo") return;
        e.preventDefault();
        onReorder(d.id, repo.id);
        clearDrag();
      }}
      onClick={() => {
        setActiveRepo(repo.id);
        ipc.touchRepo(repo.id);
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
          {!repo.missing && !repo.is_git_repo && (
            <span
              title="Not a git repository"
              className="shrink-0 rounded-sm bg-[var(--color-muted)] px-1 py-0.5 text-[10px] font-medium leading-none text-[var(--color-muted-foreground)]"
            >
              Not a git repo
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
                <span className="font-medium text-[var(--color-foreground)]">{repo.name}</span> from
                Gamut? This only removes it from the list — your files on disk are not touched.
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
            onDragStart={(e) => e.stopPropagation()}
          >
            <BranchSwitcher repoId={repo.id} currentBranch={status?.branch} />
            <SyncControls repoId={repo.id} ahead={status?.ahead} behind={status?.behind} />
          </div>
        )}
      </div>
    </div>
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

  const statusById = new Map((statuses.data ?? []).map((s) => [s.id, s]));

  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [editGroupOpen, setEditGroupOpen] = useState(false);

  const allRepos = repos.data ?? [];
  const allGroups = groups.data ?? [];
  const activeGroup = allGroups.find((g) => g.id === activeGroupId);
  const defaultGroup = allGroups.find((g) => g.is_default) ?? allGroups[0];
  // A folder-bound group can open a terminal at its parent directory — useful
  // for operating across all the repos under that folder at once.
  const groupFolder = activeGroup?.folder_path ?? null;

  const visible = visibleRepos(allRepos, activeGroup);
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

  return (
    <aside className="flex h-full w-full flex-col" style={{ background: "var(--color-sidebar)" }}>
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

      <div className="min-h-0 flex-1 overflow-auto p-2">
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
                onRemove={(repo) => removeRepo.mutate(repo.id)}
                onReorder={reorder}
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
                    onRemove={(repo) => removeRepo.mutate(repo.id)}
                    onReorder={reorder}
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
    </aside>
  );
}
