import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { relativeTime } from "@/lib/format";
import { ipc, type DeleteResult } from "@/lib/ipc";
import { toast } from "@/store/toast";

/**
 * "Clean up stale branches" flow: runs a prune fetch, lists local branches
 * whose upstream is gone (merged & deleted on remote), lets the user review
 * and deselect, then force-deletes the chosen ones. Nothing is deleted without
 * the user confirming from this panel.
 */
export function CleanupStaleDialog({
  repoId,
  open,
  onOpenChange,
}: {
  repoId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Opening the dialog runs the prune fetch + scan. Always refetch on reopen so
  // the list reflects the current remote state.
  const scan = useQuery({
    queryKey: ["stale-branches", repoId],
    queryFn: () => ipc.listStaleBranches(repoId),
    enabled: open,
    gcTime: 0,
    staleTime: 0,
  });

  // Default to everything selected once results arrive.
  useEffect(() => {
    if (scan.data) setSelected(new Set(scan.data.map((b) => b.name)));
  }, [scan.data]);

  const del = useMutation({
    mutationFn: (names: string[]) => ipc.deleteBranches(repoId, names),
    onSuccess: (results: DeleteResult[]) => {
      const deleted = results.filter((r) => r.deleted);
      const failed = results.filter((r) => !r.deleted);
      qc.invalidateQueries({ queryKey: ["stale-branches", repoId] });
      qc.invalidateQueries({ queryKey: ["branches", repoId] });
      qc.invalidateQueries({ queryKey: ["log", repoId] });
      qc.invalidateQueries({ queryKey: ["repo-statuses"] });
      if (deleted.length > 0) {
        toast.success(
          `Deleted ${deleted.length} stale branch${deleted.length === 1 ? "" : "es"}`,
        );
      }
      for (const f of failed) {
        toast.error(`Couldn't delete ${f.name}: ${f.error ?? "unknown error"}`);
      }
      if (failed.length === 0) onOpenChange(false);
    },
  });

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  const branches = scan.data ?? [];
  const allSelected = branches.length > 0 && selected.size === branches.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Clean up stale branches</DialogTitle>
          <DialogDescription>
            Local branches whose upstream was deleted on the remote (merged &amp;
            gone). The current branch and <code>main</code>/<code>master</code>{" "}
            are never listed.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 min-h-24 overflow-auto rounded-md border">
          {scan.isPending ? (
            <div className="flex items-center justify-center gap-2 p-6 text-sm text-[var(--color-muted-foreground)]">
              <Loader2 className="size-4 animate-spin" /> Fetching &amp; scanning…
            </div>
          ) : scan.isError ? (
            <p className="p-4 text-center text-sm text-[var(--color-destructive)]">
              {String(scan.error)}
            </p>
          ) : branches.length === 0 ? (
            <p className="p-6 text-center text-sm text-[var(--color-muted-foreground)]">
              No stale branches — your local branches are all current.
            </p>
          ) : (
            branches.map((b) => (
              <label
                key={b.name}
                className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 last:border-b-0 hover:bg-[var(--color-accent)]"
              >
                <input
                  type="checkbox"
                  checked={selected.has(b.name)}
                  onChange={() => toggle(b.name)}
                />
                <GitBranch className="size-3.5 shrink-0 text-[var(--color-muted-foreground)]" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs font-medium">
                      {b.name}
                    </span>
                    {b.upstream && (
                      <span className="shrink-0 text-[10px] text-[var(--color-muted-foreground)]">
                        was {b.upstream}
                      </span>
                    )}
                  </div>
                  {b.last_commit_subject && (
                    <div className="truncate text-xs text-[var(--color-muted-foreground)]">
                      {b.last_commit_sha} · {b.last_commit_subject}
                      {b.last_commit_time != null &&
                        ` · ${relativeTime(b.last_commit_time)}`}
                    </div>
                  )}
                </div>
              </label>
            ))
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <div className="flex items-center gap-3">
            {branches.length > 0 && (
              <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(
                      allSelected ? new Set() : new Set(branches.map((b) => b.name)),
                    )
                  }
                />
                Select all
              </label>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={selected.size === 0 || del.isPending}
              onClick={() => {
                if (del.isPending) return;
                del.mutate([...selected]);
              }}
            >
              {del.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Trash2 />
              )}
              Delete {selected.size > 0 ? selected.size : ""} branch
              {selected.size === 1 ? "" : "es"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
