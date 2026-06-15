import { useState } from "react";
import { FolderSearch, FolderSync, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ipc, pickDirectory, type DiscoveredRepo } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/ui";
import {
  useBindGroupFolder,
  useGroups,
  useRegisterRepo,
  useSetRepoGroups,
} from "./api";

export function DiscoverDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [candidates, setCandidates] = useState<DiscoveredRepo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [keepSynced, setKeepSynced] = useState(false);
  const registerRepo = useRegisterRepo();
  const setRepoGroups = useSetRepoGroups();
  const bindFolder = useBindGroupFolder();
  const groups = useGroups();
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const activeGroup = groups.data?.find((g) => g.id === activeGroupId);

  // The active group can be bound to the scanned folder as long as it isn't
  // already bound (the path is immutable once set). The default group is
  // bindable too — it just auto-registers repos as ungrouped rather than as
  // explicit members.
  const canSync =
    activeGroup != null &&
    !(activeGroup.folder_path && activeGroup.folder_path !== "");

  function reset() {
    setRoot(null);
    setCandidates([]);
    setSelected(new Set());
    setKeepSynced(false);
  }

  async function chooseAndScan() {
    const dir = await pickDirectory("Choose a folder to scan");
    if (!dir) return;
    setRoot(dir);
    setScanning(true);
    setCandidates([]);
    try {
      const found = await ipc.discoverRepos(dir);
      setCandidates(found);
      // Pre-select everything not already registered.
      setSelected(
        new Set(found.filter((c) => !c.already_registered).map((c) => c.path)),
      );
    } finally {
      setScanning(false);
    }
  }

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  async function addSelected() {
    setAdding(true);
    const assignToGroup =
      activeGroupId != null && activeGroup != null && !activeGroup.is_default;
    try {
      if (keepSynced && canSync && root && activeGroupId != null) {
        // Bind the active group to this folder; its initial scan add-adds every
        // discovered repo (selection is moot — a bound folder syncs them all)
        // and it keeps auto-adding new repos that appear here later.
        await bindFolder.mutateAsync({ id: activeGroupId, folderPath: root });
      } else {
        for (const path of selected) {
          const repo = await registerRepo.mutateAsync(path);
          if (assignToGroup) {
            await setRepoGroups.mutateAsync({
              repoId: repo.id,
              groupIds: [activeGroupId],
            });
          }
        }
      }
      onOpenChange(false);
      reset();
    } finally {
      setAdding(false);
    }
  }

  const newCount = candidates.filter((c) => !c.already_registered).length;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Scan folder for repositories</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={chooseAndScan} disabled={scanning}>
            {scanning ? <Loader2 className="animate-spin" /> : <FolderSearch />}
            Choose folder…
          </Button>
          {root && (
            <span className="truncate text-xs text-[var(--color-muted-foreground)]" title={root}>
              {root}
            </span>
          )}
        </div>

        {root && !scanning && (
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Found {candidates.length} repo{candidates.length === 1 ? "" : "s"} · {newCount} new
          </p>
        )}

        <div className="max-h-72 overflow-auto rounded-md border">
          {candidates.length === 0 && !scanning ? (
            <p className="p-4 text-center text-sm text-[var(--color-muted-foreground)]">
              {root ? "No git repositories found." : "Choose a folder to begin."}
            </p>
          ) : (
            candidates.map((c) => (
              <label
                key={c.path}
                className={cn(
                  "flex cursor-pointer items-center gap-3 border-b px-3 py-2 last:border-b-0",
                  c.already_registered && "opacity-50",
                )}
              >
                <input
                  type="checkbox"
                  disabled={c.already_registered}
                  checked={selected.has(c.path)}
                  onChange={() => toggle(c.path)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {c.name}
                    {c.default_branch && (
                      <span className="text-xs text-[var(--color-muted-foreground)]">
                        {c.default_branch}
                      </span>
                    )}
                    {c.already_registered && (
                      <span className="text-xs text-[var(--color-muted-foreground)]">
                        · added
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-[var(--color-muted-foreground)]">
                    {c.path}
                  </div>
                </div>
              </label>
            ))
          )}
        </div>

        {canSync && root && !scanning && (
          <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={keepSynced}
              onChange={(e) => setKeepSynced(e.target.checked)}
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <FolderSync className="size-3.5 text-[var(--color-muted-foreground)]" />
                Keep “{activeGroup!.name}” in sync with this folder
              </span>
              <span className="mt-0.5 block text-xs text-[var(--color-muted-foreground)]">
                {keepSynced
                  ? "All repos here are added now, and new ones added later are too."
                  : "New repos added here will be automatically added to this group."}
              </span>
            </span>
          </label>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {keepSynced ? (
            <Button onClick={addSelected} disabled={adding}>
              {adding ? <Loader2 className="animate-spin" /> : <FolderSync />}
              Sync folder
            </Button>
          ) : (
            <Button onClick={addSelected} disabled={selected.size === 0 || adding}>
              {adding && <Loader2 className="animate-spin" />}
              Add {selected.size > 0 ? selected.size : ""} repo
              {selected.size === 1 ? "" : "s"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
