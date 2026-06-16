import { useEffect, useState, type DragEvent } from "react";
import { Pencil, Plus, Settings, SquareTerminal } from "lucide-react";

import {
  ContextMenu,
  ContextMenuItem,
  type ContextMenuPosition,
} from "@/components/ui/context-menu";
import { GROUP_ICONS, groupInitials } from "@/lib/groupIcons";
import { clearDrag, getDrag, moveAdjacent, setDrag } from "@/lib/dnd";
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
  onRepoDrop,
  onGroupReorder,
  onContextMenu,
}: {
  group: Group;
  active: boolean;
  onSelect: () => void;
  onRepoDrop: (repoId: number) => void;
  onGroupReorder: (srcId: number, targetId: number, position: "before" | "after") => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const Icon = group.icon ? GROUP_ICONS[group.icon] : null;
  // `repoOver` = a repo is hovering to be assigned into this group (ring).
  // `reorderEdge` = a group is hovering to be reordered next to this one; the
  // edge (the rail is a vertical stack) shows a between-items line instead.
  const [repoOver, setRepoOver] = useState(false);
  const [reorderEdge, setReorderEdge] = useState<"top" | "bottom" | null>(null);

  // Which side of this button the cursor is on — before (top) or after (bottom).
  function edgeFor(e: DragEvent<HTMLButtonElement>): "top" | "bottom" {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY > rect.top + rect.height / 2 ? "bottom" : "top";
  }

  function reset() {
    setRepoOver(false);
    setReorderEdge(null);
  }

  return (
    <button
      title={group.name}
      draggable
      onDragStart={(e) => {
        setDrag({ kind: "group", id: group.id });
        e.dataTransfer.setData("text/plain", group.name);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => {
        clearDrag();
        reset();
      }}
      onDragOver={(e) => {
        const d = getDrag();
        if (d?.kind === "repo") {
          e.preventDefault();
          setRepoOver(true);
        } else if (d?.kind === "group" && d.id !== group.id) {
          e.preventDefault();
          setReorderEdge(edgeFor(e));
        }
      }}
      onDragLeave={reset}
      onDrop={(e) => {
        const d = getDrag();
        if (d?.kind === "repo") {
          e.preventDefault();
          onRepoDrop(d.id);
        } else if (d?.kind === "group" && d.id !== group.id) {
          e.preventDefault();
          onGroupReorder(d.id, group.id, edgeFor(e) === "bottom" ? "after" : "before");
        }
        reset();
        clearDrag();
      }}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      className={cn(
        "flex size-10 items-center justify-center rounded-lg border text-xs font-semibold transition-colors",
        repoOver
          ? "border-[var(--color-primary)] ring-2 ring-[var(--color-primary)]"
          : active
            ? "border-[var(--color-primary)] bg-[var(--color-accent)] text-[var(--color-foreground)]"
            : "border-transparent text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]",
        // Reorder uses a line on the edge between buttons (distinct from the
        // repo-assignment ring), matching the repo list's between-items style.
        // Listed last so the edge colour wins over the all-sides border colour.
        reorderEdge === "top" && "border-t-2 border-t-[var(--color-primary)]",
        reorderEdge === "bottom" && "border-b-2 border-b-[var(--color-primary)]",
      )}
    >
      {Icon ? <Icon className="size-5" /> : groupInitials(group.name)}
    </button>
  );
}

export function GroupRail() {
  const groups = useGroups();
  const setRepoGroups = useSetRepoGroups();
  const reorderGroups = useReorderGroups();
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const setActiveGroup = useUiStore((s) => s.setActiveGroup);
  const addTerminalTab = useUiStore((s) => s.addTerminalTab);
  const terminalOpen = useUiStore((s) => s.terminalOpen);
  const toggleTerminal = useUiStore((s) => s.toggleTerminal);
  const toggleSettings = useUiStore((s) => s.toggleSettings);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Group | null>(null);
  const [menu, setMenu] = useState<{ at: ContextMenuPosition; group: Group } | null>(
    null,
  );

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

  function handleGroupReorder(
    srcId: number,
    targetId: number,
    position: "before" | "after",
  ) {
    const order = moveAdjacent(
      list.map((g) => g.id),
      srcId,
      targetId,
      position,
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
          onRepoDrop={(repoId) => handleRepoDrop(g, repoId)}
          onGroupReorder={handleGroupReorder}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ at: { x: e.clientX, y: e.clientY }, group: g });
          }}
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

      <div className="mt-auto flex flex-col items-center gap-1.5">
        <button
          aria-label={terminalOpen ? "Hide terminal" : "Show terminal"}
          title={terminalOpen ? "Hide terminal (⌘`)" : "Show terminal (⌘`)"}
          onClick={toggleTerminal}
          className={cn(
            "flex size-10 items-center justify-center rounded-lg border transition-colors",
            terminalOpen
              ? "border-[var(--color-primary)] bg-[var(--color-accent)] text-[var(--color-foreground)]"
              : "border-transparent text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]",
          )}
        >
          <SquareTerminal className="size-5" />
        </button>
        <GitHubConnect />
        <button
          aria-label="Settings"
          title="Settings (⌘,)"
          onClick={toggleSettings}
          className="flex size-10 items-center justify-center rounded-lg border border-transparent text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
        >
          <Settings className="size-5" />
        </button>
      </div>

      <GroupDialog
        group={editing}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(g) => setActiveGroup(g.id)}
        onDeleted={() => setActiveGroup(defaultGroup?.id ?? null)}
      />

      <ContextMenu at={menu?.at ?? null} onClose={() => setMenu(null)}>
        {menu && (
          <>
            {menu.group.folder_path ? (
              <ContextMenuItem
                onClick={() => {
                  setActiveGroup(menu.group.id);
                  addTerminalTab(
                    menu.group.id,
                    menu.group.folder_path ?? "",
                    menu.group.name,
                  );
                  setMenu(null);
                }}
              >
                <SquareTerminal />
                Open terminal
              </ContextMenuItem>
            ) : (
              <div className="px-3 py-1.5 text-xs text-[var(--color-muted-foreground)]">
                Bind a folder to open a terminal
              </div>
            )}
            <ContextMenuItem
              onClick={() => {
                setEditing(menu.group);
                setDialogOpen(true);
                setMenu(null);
              }}
            >
              <Pencil />
              Edit group
            </ContextMenuItem>
          </>
        )}
      </ContextMenu>
    </nav>
  );
}
