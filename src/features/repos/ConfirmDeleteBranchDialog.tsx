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
 * Confirms deleting one local branch from the Repo settings "Branches"
 * section. `merged` is known up front from the branch row's own `merged`
 * flag (#326), so the escalated variant renders directly — no need to try a
 * plain delete first and react to a refusal. A merged branch gets one plain
 * confirmation; an unmerged one gets a visibly stronger warning and a button
 * that sends `force: true`. Mirrors `ConfirmRemoveReposDialog`'s shape —
 * bespoke per flow, never `window.confirm`.
 */
export function ConfirmDeleteBranchDialog({
  branchName,
  merged,
  open,
  onOpenChange,
  onConfirm,
}: {
  branchName: string | null;
  merged: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (force: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {merged
              ? `Delete branch "${branchName}"?`
              : `Force delete unmerged branch "${branchName}"?`}
          </DialogTitle>
          <DialogDescription className="break-all">
            {merged
              ? "This deletes the local branch. It cannot be undone."
              : `"${branchName}" has commits that aren't merged into the current branch — deleting it loses them for good.`}
          </DialogDescription>
        </DialogHeader>

        {!merged && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-[var(--color-destructive)]/40 bg-[var(--color-destructive)]/10 p-2 text-xs text-[var(--color-destructive)]"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            This branch is not fully merged. Forcing the delete discards its unmerged commits.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => onConfirm(!merged)}>
            <Trash2 />
            {merged ? "Delete branch" : "Force delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
