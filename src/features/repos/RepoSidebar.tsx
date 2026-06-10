import { useState } from "react";
import {
  FolderGit2,
  GripVertical,
  Pencil,
  Plus,
  FolderSearch,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BranchSwitcher } from "@/features/history/BranchSwitcher";
import { SyncControls } from "@/features/sync/SyncControls";
import { clearDrag, getDrag, moveBefore, setDrag } from "@/lib/dnd";
import { ipc, pickDirectory, type Repo, type RepoStatus } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/ui";
import {
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
  const [dropOver, setDropOver] = useState(false);
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
        active
          ? "border-l-[#2563eb] bg-[#2563eb]/15 font-medium text-[var(--color-foreground)]"
          : "border-l-transparent hover:bg-[var(--color-accent)]",
      )}
    >
      <GripVertical className="mt-0.5 size-3.5 shrink-0 cursor-grab text-[var(--color-muted-foreground)] opacity-0 group-hover:opacity-60" />
      <FolderGit2
        className={cn(
          "mt-0.5 size-4 shrink-0",
          active ? "text-[#2563eb]" : "text-[var(--color-muted-foreground)]",
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate leading-tight">{repo.name}</span>
          <button
            aria-label="Remove repository"
            title="Remove from Gamut"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(repo);
            }}
            className="shrink-0 opacity-0 transition-opacity hover:text-[var(--color-destructive)] group-hover:opacity-100"
          >
            <Trash2 className="size-3.5 text-[var(--color-muted-foreground)] hover:text-[var(--color-destructive)]" />
          </button>
        </div>
        {/* Per-repo branch switcher + sync controls (manage without selecting). */}
        <div
          className="flex w-fit items-center gap-0.5"
          onClick={(e) => e.stopPropagation()}
          onDragStart={(e) => e.stopPropagation()}
        >
          <BranchSwitcher repoId={repo.id} currentBranch={status?.branch} />
          <SyncControls
            repoId={repo.id}
            ahead={status?.ahead}
            behind={status?.behind}
          />
        </div>
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
  const statuses = useRepoStatuses();
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const setActiveGroup = useUiStore((s) => s.setActiveGroup);

  const statusById = new Map((statuses.data ?? []).map((s) => [s.id, s]));

  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [editGroupOpen, setEditGroupOpen] = useState(false);
  const [removing, setRemoving] = useState<Repo | null>(null);

  const allRepos = repos.data ?? [];
  const allGroups = groups.data ?? [];
  const activeGroup = allGroups.find((g) => g.id === activeGroupId);
  const defaultGroup = allGroups.find((g) => g.is_default) ?? allGroups[0];

  // Default group = repos with no explicit group; others = repos assigned to it.
  const visible = activeGroup?.is_default
    ? allRepos.filter((r) => r.group_ids.length === 0)
    : allRepos.filter((r) => activeGroupId != null && r.group_ids.includes(activeGroupId));

  function reorder(srcId: number, targetId: number) {
    const order = moveBefore(
      visible.map((r) => r.id),
      srcId,
      targetId,
    );
    reorderRepos.mutate(order);
  }

  async function addRepo() {
    const dir = await pickDirectory("Choose a git repository");
    if (!dir) return;
    const repo = await registerRepo.mutateAsync(dir);
    // Add the new repo to the active (non-default) group so it shows up here.
    if (activeGroupId != null && activeGroup && !activeGroup.is_default) {
      setRepoGroups.mutate({ repoId: repo.id, groupIds: [activeGroupId] });
    }
  }

  return (
    <aside
      className="flex h-full w-full flex-col"
      style={{ background: "var(--color-sidebar)" }}
    >
      <header className="flex items-center justify-between gap-1 border-b px-3 py-2">
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
          <Button size="icon" variant="ghost" className="size-7" title="Add repository" onClick={addRepo}>
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
          visible.map((r) => (
            <RepoRow
              key={r.id}
              repo={r}
              status={statusById.get(r.id)}
              onRemove={setRemoving}
              onReorder={reorder}
            />
          ))
        )}
      </div>

      <DiscoverDialog open={discoverOpen} onOpenChange={setDiscoverOpen} />

      <GroupDialog
        group={activeGroup ?? null}
        open={editGroupOpen}
        onOpenChange={setEditGroupOpen}
        onDeleted={() => setActiveGroup(defaultGroup?.id ?? null)}
      />

      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove repository?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Remove <span className="font-medium text-[var(--color-foreground)]">{removing?.name}</span> from
            Gamut? This only removes it from the list — your files on disk are
            not touched.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing) removeRepo.mutate(removing.id);
                setRemoving(null);
              }}
            >
              <Trash2 /> Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
