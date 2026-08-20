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

/**
 * Confirms removing one linked worktree from the Repo settings "Worktrees"
 * section. Unlike branch delete, "dirty" isn't known up front — the plain
 * confirmation always renders first; only after the backend refuses (the
 * worktree has uncommitted changes) does the caller re-open this dialog in
 * its `escalated` form, offering a visibly stronger confirmation that sends
 * `force: true`. Mirrors `ConfirmRemoveReposDialog`'s shape — bespoke per
 * flow, never `window.confirm`.
 */
export function ConfirmRemoveWorktreeDialog({
  path,
  escalated,
  open,
  onOpenChange,
  onConfirm,
}: {
  path: string | null;
  escalated: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (force: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {escalated ? "Force remove worktree with uncommitted changes?" : "Remove worktree?"}
          </DialogTitle>
          <DialogDescription className="break-all">
            {escalated
              ? `"${path}" has uncommitted changes that would be lost.`
              : `This removes the linked worktree at "${path}" — its checkout is deleted from disk.`}
          </DialogDescription>
        </DialogHeader>

        {escalated && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-[var(--color-destructive)]/40 bg-[var(--color-destructive)]/10 p-2 text-xs text-[var(--color-destructive)]"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            Forcing the removal discards any uncommitted changes in this worktree.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => onConfirm(escalated)}>
            <Trash2 />
            {escalated ? "Force remove" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
