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
import { Input } from "@/components/ui/input";
import { GROUP_ICONS, GROUP_ICON_KEYS, groupInitials } from "@/lib/groupIcons";
import type { Group } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useCreateGroup, useDeleteGroup, useUpdateGroup } from "./api";

export function GroupDialog({
  group,
  open,
  onOpenChange,
  onDeleted,
}: {
  /** null = create mode; a Group = edit mode. */
  group: Group | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const create = useCreateGroup();
  const update = useUpdateGroup();
  const remove = useDeleteGroup();

  useEffect(() => {
    if (open) {
      setName(group?.name ?? "");
      setIcon(group?.icon ?? null);
    }
  }, [open, group]);

  const editing = group != null;

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (editing) {
      update.mutate(
        { id: group.id, name: trimmed, icon },
        { onSuccess: () => onOpenChange(false) },
      );
    } else {
      create.mutate(
        { name: trimmed, icon },
        { onSuccess: () => onOpenChange(false) },
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit group" : "New group"}</DialogTitle>
        </DialogHeader>

        <Input
          autoFocus
          placeholder="Group name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />

        <div>
          <p className="mb-2 text-xs font-medium text-[var(--color-muted-foreground)]">
            Icon
          </p>
          <div className="flex flex-wrap gap-1.5">
            {/* Initials (no icon) */}
            <button
              type="button"
              title="Use initials"
              onClick={() => setIcon(null)}
              className={cn(
                "flex size-9 items-center justify-center rounded-md border text-xs font-semibold",
                icon === null
                  ? "border-[var(--color-primary)] bg-[var(--color-accent)]"
                  : "hover:bg-[var(--color-accent)]",
              )}
            >
              {groupInitials(name || "Aa")}
            </button>
            {GROUP_ICON_KEYS.map((key) => {
              const Icon = GROUP_ICONS[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setIcon(key)}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-md border",
                    icon === key
                      ? "border-[var(--color-primary)] bg-[var(--color-accent)]"
                      : "hover:bg-[var(--color-accent)]",
                  )}
                >
                  <Icon className="size-4" />
                </button>
              );
            })}
          </div>
        </div>

        <DialogFooter className={cn(editing && !group?.is_default && "sm:justify-between")}>
          {editing && !group?.is_default && (
            <Button
              variant="ghost"
              className="text-[var(--color-destructive)]"
              onClick={() =>
                remove.mutate(group.id, {
                  onSuccess: () => {
                    onDeleted?.();
                    onOpenChange(false);
                  },
                })
              }
            >
              <Trash2 /> Delete
            </Button>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!name.trim()}>
              {editing ? "Save" : "Create"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
