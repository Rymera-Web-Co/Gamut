import { AlertTriangle, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Repo } from "@/lib/ipc";
import { cn } from "@/lib/utils";

/**
 * The single confirmation dialog for both the single-row trash icon and the
 * multi-selection bulk-remove path (#294) — replaces the old per-row `Popover`
 * and the context menu's `window.confirm`. Lists every repo about to be
 * removed, flags the missing ones, and calls out a `root` row explicitly
 * rather than silently dropping it (removing a group's synced root drops that
 * group's root association with no cascade to warn otherwise).
 */
export function ConfirmRemoveReposDialog({
  repos,
  hasRoot,
  open,
  onOpenChange,
  onConfirm,
}: {
  repos: Repo[];
  hasRoot: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const n = repos.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Remove {n} repository folder{n === 1 ? "" : "s"}?
          </DialogTitle>
          <DialogDescription>
            This only removes {n === 1 ? "it" : "them"} from Gamut — your files on disk are not
            deleted. A healthy repo inside a synced folder will be re-added the next time that
            folder is scanned; missing ones will not come back.
          </DialogDescription>
        </DialogHeader>

        {/* Scrollable — a bound folder can easily produce 20+ dangling rows. */}
        <ul className="max-h-72 overflow-auto rounded-md border">
          {repos.map((r) => (
            <li
              key={r.id}
              className="flex items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0"
            >
              {/* The path, not just the name: repo names are derived from the
                  folder name and are routinely duplicated (several `docs`
                  folders across different projects), so the name alone can't
                  tell the user which folder is about to go. */}
              <div className="min-w-0 flex-1">
                <div
                  className={cn(
                    "truncate",
                    r.missing && "line-through decoration-[var(--color-destructive)]/60",
                  )}
                >
                  {r.name}
                </div>
                <div className="truncate text-xs text-[var(--color-muted-foreground)]">
                  {r.path}
                </div>
              </div>
              {r.missing && (
                <AlertTriangle
                  className="size-3.5 shrink-0 text-[var(--color-destructive)]"
                  aria-label="Folder no longer exists"
                />
              )}
            </li>
          ))}
        </ul>

        {repos.some((r) => r.missing) && (
          <p className="text-xs text-[var(--color-muted-foreground)]">
            ⚠ = folder no longer exists on disk
          </p>
        )}

        {hasRoot && (
          <p
            role="alert"
            className="rounded-md border border-[var(--color-destructive)]/40 bg-[var(--color-destructive)]/10 p-2 text-xs text-[var(--color-destructive)]"
          >
            The selection includes a group's synced root folder — removing it drops that group's
            root association.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {/* No in-flight state: `onConfirm` closes the dialog in the same tick
              it fires the mutation, so there is no pending window to show and no
              double-submit to guard. Failures surface as a toast. */}
          <Button variant="destructive" disabled={n === 0} onClick={onConfirm}>
            <Trash2 />
            Remove {n}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
