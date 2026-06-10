import { useState } from "react";
import { FolderGit2, Plus, FolderSearch, Settings2, Tag as TagIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ipc, pickDirectory, type Repo, type Tag } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/ui";
import { useGroups, useRegisterRepo, useRepos, useSetRepoGroups, useTags } from "./api";
import { NewTagDialog } from "./CreateDialogs";
import { DiscoverDialog } from "./DiscoverDialog";
import { EditRepoDialog } from "./EditRepoDialog";

function RepoRow({
  repo,
  tags,
  onEdit,
}: {
  repo: Repo;
  tags: Tag[];
  onEdit: (repo: Repo) => void;
}) {
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  const setActiveRepo = useUiStore((s) => s.setActiveRepo);
  const repoTags = tags.filter((t) => repo.tag_ids.includes(t.id));

  return (
    <div
      role="button"
      tabIndex={0}
      title={repo.path}
      onClick={() => {
        setActiveRepo(repo.id);
        ipc.touchRepo(repo.id);
      }}
      className={cn(
        "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        activeRepoId === repo.id
          ? "bg-[var(--color-accent)]"
          : "hover:bg-[var(--color-accent)]",
      )}
    >
      <FolderGit2 className="size-4 shrink-0 text-[var(--color-muted-foreground)]" />
      <span className="min-w-0 flex-1 truncate">{repo.name}</span>
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
  const activeGroupId = useUiStore((s) => s.activeGroupId);

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
      className="flex w-64 shrink-0 flex-col border-r"
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
            <RepoRow key={r.id} repo={r} tags={allTags} onEdit={setEditing} />
          ))
        )}
      </div>

      <DiscoverDialog open={discoverOpen} onOpenChange={setDiscoverOpen} />
      <NewTagDialog open={newTagOpen} onOpenChange={setNewTagOpen} />
      <EditRepoDialog repo={editing} onOpenChange={(o) => !o && setEditing(null)} />
    </aside>
  );
}
