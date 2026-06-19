import { useEffect, useState } from "react";
import { FolderInput, FolderSync, Loader2, Lock, RefreshCw, Trash2, Unlink } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { relativeTimeSqlite } from "@/lib/format";
import { visibleRepos } from "@/lib/groupRepos";
import { GROUP_ICONS, GROUP_ICON_KEYS, groupInitials } from "@/lib/groupIcons";
import { pickDirectory, type Group } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import {
  useBindGroupFolder,
  useCreateGroup,
  useDeleteGroup,
  useRepos,
  useSyncGroupFolder,
  useUnbindGroupFolder,
  useUpdateGroup,
} from "./api";

export function GroupDialog({
  group,
  open,
  onOpenChange,
  onCreated,
  onDeleted,
}: {
  /** null = create mode; a Group = edit mode. */
  group: Group | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (group: Group) => void;
  onDeleted?: () => void;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  // Folder binding (create mode, and first-bind of an unbound group in edit mode).
  const [bindEnabled, setBindEnabled] = useState(false);
  const [folderPath, setFolderPath] = useState<string | null>(null);

  const create = useCreateGroup();
  const update = useUpdateGroup();
  const remove = useDeleteGroup();
  const bind = useBindGroupFolder();
  const sync = useSyncGroupFolder();
  const unbind = useUnbindGroupFolder();
  const repos = useRepos();

  useEffect(() => {
    if (open) {
      setName(group?.name ?? "");
      setIcon(group?.icon ?? null);
      setBindEnabled(false);
      setFolderPath(null);
    }
  }, [open, group]);

  const editing = group != null;
  const bound = group?.folder_path != null && group.folder_path !== "";
  // Binding controls are offered on create, and on edit for any not-yet-bound
  // group (first bind) — including the default group, which auto-registers
  // repos as ungrouped rather than as explicit members.
  const canOfferBind = !editing || !bound;
  // The default group shows ungrouped repos; everything else counts members.
  const repoCount = group ? visibleRepos(repos.data ?? [], group).length : 0;
  const busy = create.isPending || update.isPending || bind.isPending || sync.isPending;

  async function chooseFolder() {
    const dir = await pickDirectory("Choose a folder to keep in sync");
    if (dir) setFolderPath(dir);
  }

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (editing) {
      update.mutate(
        { id: group.id, name: trimmed, icon },
        {
          onSuccess: async () => {
            // First-bind an unbound group if the user opted in during edit.
            if (canOfferBind && bindEnabled && folderPath) {
              await bind.mutateAsync({ id: group.id, folderPath });
            }
            onOpenChange(false);
          },
        },
      );
    } else {
      create.mutate(
        { name: trimmed, icon, folderPath: bindEnabled ? folderPath : null },
        {
          onSuccess: (g) => {
            onCreated?.(g);
            onOpenChange(false);
          },
        },
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
          <p className="mb-2 text-xs font-medium text-[var(--color-muted-foreground)]">Icon</p>
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

        {/* Synced folder */}
        {bound ? (
          <BoundFolderSection
            path={group!.folder_path!}
            repoCount={repoCount}
            lastScanAt={group!.last_scan_at}
            rescanning={sync.isPending}
            unbinding={unbind.isPending}
            onRescan={() => sync.mutate(group!.id)}
            onUnbind={() => unbind.mutate(group!.id)}
          />
        ) : (
          canOfferBind && (
            <div className="rounded-md border p-3">
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={bindEnabled}
                  onChange={(e) => setBindEnabled(e.target.checked)}
                />
                <span className="text-sm font-medium">Keep this group in sync with a folder</span>
              </label>
              {bindEnabled && (
                <div className="mt-2 space-y-1.5 pl-6">
                  <Button type="button" size="sm" variant="outline" onClick={chooseFolder}>
                    <FolderInput /> Choose folder…
                  </Button>
                  {folderPath && (
                    <p
                      className="truncate font-mono text-xs text-[var(--color-muted-foreground)]"
                      title={folderPath}
                    >
                      {folderPath}
                    </p>
                  )}
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    New repos added here are automatically added to this group.
                  </p>
                </div>
              )}
            </div>
          )
        )}

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
            <Button onClick={submit} disabled={!name.trim() || busy}>
              {busy && <Loader2 className="animate-spin" />}
              {editing ? "Save" : "Create"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Read-only bound-folder panel shown in edit mode for a folder-bound group. */
function BoundFolderSection({
  path,
  repoCount,
  lastScanAt,
  rescanning,
  unbinding,
  onRescan,
  onUnbind,
}: {
  path: string;
  repoCount: number;
  lastScanAt: string | null;
  rescanning: boolean;
  unbinding: boolean;
  onRescan: () => void;
  onUnbind: () => void;
}) {
  const lastScan = lastScanAt ? relativeTimeSqlite(lastScanAt) : null;
  return (
    <div className="rounded-md border p-3">
      <p className="mb-2 text-xs font-medium text-[var(--color-muted-foreground)]">Synced folder</p>
      <div
        className="flex items-center gap-2 rounded-md bg-[var(--color-accent)] px-2 py-1.5"
        title="The bound folder cannot be changed"
      >
        <FolderSync className="size-4 shrink-0 text-[var(--color-muted-foreground)]" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
          {path}
        </span>
        <span
          className="flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]"
          title="The bound folder cannot be changed"
        >
          <Lock className="size-3" /> can't change
        </span>
      </div>
      <p className="mt-1.5 text-xs text-[var(--color-muted-foreground)]">
        Auto-syncing • {repoCount} repo{repoCount === 1 ? "" : "s"}
        {lastScan ? ` • last scan ${lastScan}` : ""}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onRescan} disabled={rescanning}>
          {rescanning ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Rescan now
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-[var(--color-muted-foreground)]"
          onClick={onUnbind}
          disabled={unbinding}
          title="Stop syncing; keeps the repos already in this group"
        >
          <Unlink /> Unbind
        </Button>
      </div>
    </div>
  );
}
