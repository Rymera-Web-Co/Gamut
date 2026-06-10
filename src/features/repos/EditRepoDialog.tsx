import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Repo } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import {
  useGroups,
  useRemoveRepo,
  useSetRepoGroups,
  useSetRepoTags,
  useTags,
} from "./api";

function toggle(set: number[], id: number): number[] {
  return set.includes(id) ? set.filter((x) => x !== id) : [...set, id];
}

export function EditRepoDialog({
  repo,
  onOpenChange,
}: {
  repo: Repo | null;
  onOpenChange: (open: boolean) => void;
}) {
  const tags = useTags();
  const groups = useGroups();
  const setRepoTags = useSetRepoTags();
  const setRepoGroups = useSetRepoGroups();
  const removeRepo = useRemoveRepo();

  const [tagIds, setTagIds] = useState<number[]>([]);
  // A repo belongs to at most one group; null means the default group.
  const [groupId, setGroupId] = useState<number | null>(null);

  useEffect(() => {
    if (repo) {
      setTagIds(repo.tag_ids);
      setGroupId(repo.group_ids[0] ?? null);
    }
  }, [repo]);

  if (!repo) return null;

  function save() {
    if (!repo) return;
    setRepoTags.mutate({ repoId: repo.id, tagIds });
    setRepoGroups.mutate({
      repoId: repo.id,
      groupIds: groupId != null ? [groupId] : [],
    });
    onOpenChange(false);
  }

  function remove() {
    if (!repo) return;
    removeRepo.mutate(repo.id, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog open={!!repo} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{repo.name}</DialogTitle>
        </DialogHeader>
        <p className="truncate text-xs text-[var(--color-muted-foreground)]" title={repo.path}>
          {repo.path}
        </p>

        <section className="space-y-2">
          <h3 className="text-sm font-medium">Tags</h3>
          {tags.data && tags.data.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {tags.data.map((t) => {
                const on = tagIds.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTagIds((s) => toggle(s, t.id))}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                      on
                        ? "border-transparent text-white"
                        : "text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)]",
                    )}
                    style={on ? { background: t.color } : undefined}
                  >
                    <span
                      className="size-2 rounded-full"
                      style={{ background: t.color }}
                    />
                    {t.name}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              No tags yet — create one from the toolbar.
            </p>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-medium">Group</h3>
          <div className="flex flex-col gap-1">
            {/* Default = no group. */}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="repo-group"
                checked={groupId == null}
                onChange={() => setGroupId(null)}
              />
              {groups.data?.find((g) => g.is_default)?.name ?? "Default"}
            </label>
            {(groups.data ?? [])
              .filter((g) => !g.is_default)
              .map((g) => (
                <label key={g.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="repo-group"
                    checked={groupId === g.id}
                    onChange={() => setGroupId(g.id)}
                  />
                  {g.name}
                </label>
              ))}
          </div>
        </section>

        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" onClick={remove} className="text-[var(--color-destructive)]">
            <Trash2 /> Remove
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={save}>Save</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
