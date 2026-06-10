import { useEffect, useState } from "react";
import { Pencil, Plus } from "lucide-react";

import { GROUP_ICONS, groupInitials } from "@/lib/groupIcons";
import { clearDrag, getDrag, moveBefore, setDrag } from "@/lib/dnd";
import type { Group } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/ui";
import { GitHubConnect } from "@/features/github/GitHubConnect";
import { useGroups, useReorderGroups, useSetRepoGroups } from "./api";
import { GroupDialog } from "./GroupDialog";

function GroupButton({
  group,
  active,
  onSelect,
  onEdit,
  onRepoDrop,
  onGroupReorder,
}: {
  group: Group;
  active: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onRepoDrop: (repoId: number) => void;
  onGroupReorder: (srcId: number, targetId: number) => void;
}) {
  const Icon = group.icon ? GROUP_ICONS[group.icon] : null;
  const [dropOver, setDropOver] = useState(false);

  return (
    <div className="group relative">
      <button
        title={group.name}
        draggable={!group.is_default}
        onDragStart={(e) => {
          setDrag({ kind: "group", id: group.id });
          e.dataTransfer.setData("text/plain", group.name);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          clearDrag();
          setDropOver(false);
        }}
        onDragOver={(e) => {
          const d = getDrag();
          const acceptGroup = d?.kind === "group" && !group.is_default && d.id !== group.id;
          if (d?.kind === "repo" || acceptGroup) {
            e.preventDefault();
            setDropOver(true);
          }
        }}
        onDragLeave={() => setDropOver(false)}
        onDrop={(e) => {
          setDropOver(false);
          const d = getDrag();
          if (d?.kind === "repo") {
            e.preventDefault();
            onRepoDrop(d.id);
          } else if (d?.kind === "group" && !group.is_default) {
            e.preventDefault();
            onGroupReorder(d.id, group.id);
          }
          clearDrag();
        }}
        onClick={onSelect}
        className={cn(
          "flex size-10 items-center justify-center rounded-lg border text-xs font-semibold transition-colors",
          dropOver
            ? "border-[var(--color-primary)] ring-2 ring-[var(--color-primary)]"
            : active
              ? "border-[var(--color-primary)] bg-[var(--color-accent)] text-[var(--color-foreground)]"
              : "border-transparent text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]",
        )}
      >
        {Icon ? <Icon className="size-5" /> : groupInitials(group.name)}
      </button>
      <button
        aria-label={`Edit ${group.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        className="absolute -right-0.5 -top-0.5 hidden rounded-full border bg-[var(--color-background)] p-0.5 group-hover:block"
      >
        <Pencil className="size-2.5" />
      </button>
    </div>
  );
}

export function GroupRail() {
  const groups = useGroups();
  const setRepoGroups = useSetRepoGroups();
  const reorderGroups = useReorderGroups();
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const setActiveGroup = useUiStore((s) => s.setActiveGroup);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Group | null>(null);

  const list = groups.data ?? [];
  const defaultGroup = list.find((g) => g.is_default) ?? list[0];

  useEffect(() => {
    if (list.length === 0) return;
    if (!list.some((g) => g.id === activeGroupId)) {
      setActiveGroup(defaultGroup?.id ?? null);
    }
  }, [list, activeGroupId, defaultGroup, setActiveGroup]);

  function handleRepoDrop(group: Group, repoId: number) {
    setRepoGroups.mutate({
      repoId,
      groupIds: group.is_default ? [] : [group.id],
    });
  }

  function handleGroupReorder(srcId: number, targetId: number) {
    const order = moveBefore(
      list.map((g) => g.id),
      srcId,
      targetId,
    );
    reorderGroups.mutate(order);
  }

  return (
    <nav
      className="flex w-14 shrink-0 flex-col items-center gap-1.5 border-r py-3"
      style={{ background: "var(--color-sidebar)" }}
      aria-label="Groups"
    >
      {list.map((g) => (
        <GroupButton
          key={g.id}
          group={g}
          active={g.id === activeGroupId}
          onSelect={() => setActiveGroup(g.id)}
          onEdit={() => {
            setEditing(g);
            setDialogOpen(true);
          }}
          onRepoDrop={(repoId) => handleRepoDrop(g, repoId)}
          onGroupReorder={handleGroupReorder}
        />
      ))}

      <button
        aria-label="New group"
        title="New group"
        onClick={() => {
          setEditing(null);
          setDialogOpen(true);
        }}
        className="mt-1 flex size-10 items-center justify-center rounded-lg border border-dashed text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
      >
        <Plus className="size-5" />
      </button>

      <div className="mt-auto">
        <GitHubConnect />
      </div>

      <GroupDialog
        group={editing}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(g) => setActiveGroup(g.id)}
        onDeleted={() => setActiveGroup(defaultGroup?.id ?? null)}
      />
    </nav>
  );
}
