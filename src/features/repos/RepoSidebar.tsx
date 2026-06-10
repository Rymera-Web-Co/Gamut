import { useState } from "react";
import {
  FolderGit2,
  FolderPlus,
  FolderSearch,
  Plus,
  Settings2,
  Tag as TagIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ipc, pickDirectory, type Repo, type Tag } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/ui";
import { useGroups, useRegisterRepo, useRepos, useTags } from "./api";
import { NewGroupDialog, NewTagDialog } from "./CreateDialogs";
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

  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newTagOpen, setNewTagOpen] = useState(false);
  const [editing, setEditing] = useState<Repo | null>(null);

  async function addRepo() {
    const dir = await pickDirectory("Choose a git repository");
    if (dir) registerRepo.mutate(dir);
  }

  const allRepos = repos.data ?? [];
  const allTags = tags.data ?? [];
  const allGroups = groups.data ?? [];
  const ungrouped = allRepos.filter((r) => r.group_ids.length === 0);

  return (
    <aside
      className="flex w-64 shrink-0 flex-col border-r"
      style={{ background: "var(--color-sidebar)" }}
    >
      <header className="flex items-center justify-between gap-1 border-b px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
          Repositories
        </span>
        <div className="flex items-center">
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
            title="New group"
            onClick={() => setNewGroupOpen(true)}
          >
            <FolderPlus />
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
        {allRepos.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-[var(--color-muted-foreground)]">
            No repositories yet. Use the + or scan a folder.
          </p>
        ) : (
          <div className="space-y-3">
            {allGroups.map((g) => {
              const groupRepos = allRepos.filter((r) => r.group_ids.includes(g.id));
              if (groupRepos.length === 0) return null;
              return (
                <section key={g.id}>
                  <h2 className="px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
                    {g.name}
                  </h2>
                  {groupRepos.map((r) => (
                    <RepoRow key={r.id} repo={r} tags={allTags} onEdit={setEditing} />
                  ))}
                </section>
              );
            })}
            {ungrouped.length > 0 && (
              <section>
                {allGroups.length > 0 && (
                  <h2 className="px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
                    Ungrouped
                  </h2>
                )}
                {ungrouped.map((r) => (
                  <RepoRow key={r.id} repo={r} tags={allTags} onEdit={setEditing} />
                ))}
              </section>
            )}
          </div>
        )}
      </div>

      <DiscoverDialog open={discoverOpen} onOpenChange={setDiscoverOpen} />
      <NewGroupDialog open={newGroupOpen} onOpenChange={setNewGroupOpen} />
      <NewTagDialog open={newTagOpen} onOpenChange={setNewTagOpen} />
      <EditRepoDialog repo={editing} onOpenChange={(o) => !o && setEditing(null)} />
    </aside>
  );
}
