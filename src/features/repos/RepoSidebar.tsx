import { useState } from "react";
import {
  FolderGit2,
  GitBranch,
  GripVertical,
  Plus,
  FolderSearch,
  Settings2,
  Tag as TagIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { clearDrag, getDrag, moveBefore, setDrag } from "@/lib/dnd";
import { ipc, pickDirectory, type Repo, type RepoStatus, type Tag } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/ui";
import {
  useGroups,
  useRegisterRepo,
  useReorderRepos,
  useRepoStatuses,
  useRepos,
  useSetRepoGroups,
  useTags,
} from "./api";
import { NewTagDialog } from "./CreateDialogs";
import { DiscoverDialog } from "./DiscoverDialog";
import { EditRepoDialog } from "./EditRepoDialog";

function RepoRow({
  repo,
  tags,
  status,
  onEdit,
  onReorder,
}: {
  repo: Repo;
  tags: Tag[];
  status?: RepoStatus;
  onEdit: (repo: Repo) => void;
  onReorder: (srcId: number, targetId: number) => void;
}) {
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  const setActiveRepo = useUiStore((s) => s.setActiveRepo);
  const repoTags = tags.filter((t) => repo.tag_ids.includes(t.id));
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
        "group flex cursor-pointer items-center gap-1.5 rounded-md border-l-2 px-1 py-1.5 text-sm",
        dropOver && "border-t-2 border-t-[var(--color-primary)]",
        active
          ? "border-l-[#2563eb] bg-[#2563eb]/15 font-medium text-[var(--color-foreground)]"
          : "border-l-transparent hover:bg-[var(--color-accent)]",
      )}
    >
      <GripVertical className="size-3.5 shrink-0 cursor-grab text-[var(--color-muted-foreground)] opacity-0 group-hover:opacity-60" />
      <FolderGit2
        className={cn(
          "size-4 shrink-0",
          active ? "text-[#2563eb]" : "text-[var(--color-muted-foreground)]",
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate leading-tight">{repo.name}</span>
        {status?.branch && (
          <span className="flex items-center gap-1 text-[11px] leading-tight text-[var(--color-muted-foreground)]">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate">{status.branch}</span>
            {status.behind > 0 && (
              <span
                className="shrink-0 font-medium text-[#d97706]"
                title={`${status.behind} new commit${status.behind === 1 ? "" : "s"} on the remote — fetch to update`}
              >
                ↓{status.behind}
              </span>
            )}
            {status.ahead > 0 && (
              <span
                className="shrink-0 text-[var(--color-muted-foreground)]"
                title={`${status.ahead} commit${status.ahead === 1 ? "" : "s"} to push`}
              >
                ↑{status.ahead}
              </span>
            )}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {repoTags.map((t) => (
          <span
            key={t.id}
            title={t.name}
            className="size-2 rounded-full"
            style={{ background: t.color }}
          />
        ))}
        <button
          aria-label="Edit repository"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(repo);
          }}
          className="opacity-0 transition-opacity group-hover:opacity-100"
        >
          <Settings2 className="size-3.5 text-[var(--color-muted-foreground)]" />
        </button>
      </div>
    </div>
  );
}

export function RepoSidebar() {
  const repos = useRepos();
  const tags = useTags();
  const groups = useGroups();
  const registerRepo = useRegisterRepo();
  const setRepoGroups = useSetRepoGroups();
  const reorderRepos = useReorderRepos();
  const statuses = useRepoStatuses();
  const activeGroupId = useUiStore((s) => s.activeGroupId);

  const statusById = new Map((statuses.data ?? []).map((s) => [s.id, s]));

  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [newTagOpen, setNewTagOpen] = useState(false);
  const [editing, setEditing] = useState<Repo | null>(null);

  const allRepos = repos.data ?? [];
  const allTags = tags.data ?? [];
  const allGroups = groups.data ?? [];
  const activeGroup = allGroups.find((g) => g.id === activeGroupId);

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
        <span
          className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]"
          title={activeGroup?.name}
        >
          {activeGroup?.name ?? "Repositories"}
        </span>
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
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title="New tag"
            onClick={() => setNewTagOpen(true)}
          >
            <TagIcon />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {visible.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-[var(--color-muted-foreground)]">
            {allRepos.length === 0
              ? "No repositories yet. Use + or scan a folder."
              : "No repositories in this group. Use + to add one, or assign existing repos via their settings."}
          </p>
        ) : (
          visible.map((r) => (
            <RepoRow
              key={r.id}
              repo={r}
              tags={allTags}
              status={statusById.get(r.id)}
              onEdit={setEditing}
              onReorder={reorder}
            />
          ))
        )}
      </div>

      <DiscoverDialog open={discoverOpen} onOpenChange={setDiscoverOpen} />
      <NewTagDialog open={newTagOpen} onOpenChange={setNewTagOpen} />
      <EditRepoDialog repo={editing} onOpenChange={(o) => !o && setEditing(null)} />
    </aside>
  );
}
