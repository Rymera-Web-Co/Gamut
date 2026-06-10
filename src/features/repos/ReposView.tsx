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
      <span className="truncate">{repo.name}</span>
      {repo.default_branch && (
        <span className="shrink-0 text-xs text-[var(--color-muted-foreground)]">
          {repo.default_branch}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        {repoTags.map((t) => (
          <span
            key={t.id}
            title={t.name}
            className="size-2.5 rounded-full"
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
          <Settings2 className="size-4 text-[var(--color-muted-foreground)]" />
        </button>
      </div>
    </div>
  );
}

export function ReposView() {
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
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <h1 className="mr-2 text-sm font-semibold">Repositories</h1>
        <Button size="sm" variant="outline" onClick={addRepo}>
          <Plus /> Add repo
        </Button>
        <Button size="sm" variant="outline" onClick={() => setDiscoverOpen(true)}>
          <FolderSearch /> Scan folder
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setNewGroupOpen(true)}>
          <FolderPlus /> New group
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setNewTagOpen(true)}>
          <TagIcon /> New tag
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {allRepos.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <FolderGit2 className="size-8 text-[var(--color-muted-foreground)]" />
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No repositories yet. Add one or scan a folder to detect them.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {allGroups.map((g) => {
              const groupRepos = allRepos.filter((r) => r.group_ids.includes(g.id));
              if (groupRepos.length === 0) return null;
              return (
                <section key={g.id}>
                  <h2 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
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
                  <h2 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
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
    </div>
  );
}
