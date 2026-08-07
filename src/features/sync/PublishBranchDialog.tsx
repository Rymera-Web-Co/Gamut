import { useRef } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PublishBranchActions, PublishBranchMessage } from "@/features/sync/PublishBranchConfirm";
import { useSyncActions } from "@/features/sync/useSyncActions";
import { useUiStore } from "@/store/ui";

/**
 * The ⌘⇧K half of the first-publish guard (#300). The push button's own
 * confirmation is a popover anchored to it, but the shortcut can fire when that
 * button isn't rendered at all — sidebar hidden, or the active repo filtered out
 * of the list — so its question is asked app-level, where it can always be seen
 * and answered. Mounted once, from `App`.
 *
 * The push targets `pushConfirm.repoId`, the repo the question was asked about,
 * so changing the active repo while the dialog is open can't redirect it.
 */
export function PublishBranchDialog() {
  const pending = useUiStore((s) => s.pushConfirm);
  const clear = useUiStore((s) => s.clearPushConfirm);
  // Keep feeding `useSyncActions` the repo even after the question is cleared.
  // Answering dismisses the dialog *and* pushes, and the mutation reads whatever
  // repo the latest render gave it — so a bare `pending?.repoId` leaves it
  // pointed at `null` and the push dies with "No active repository". Holding the
  // last target also keeps the text from blanking out as the dialog animates shut.
  const lastTarget = useRef(pending);
  if (pending) lastTarget.current = pending;
  const target = pending ?? lastTarget.current;
  const { push } = useSyncActions(target?.repoId ?? null);
  // Whatever had focus when the shortcut fired. There's no trigger element to
  // fall back to, and Radix suppresses its own restore, so without this the
  // dialog drops focus onto <body> and the next Tab restarts from the top.
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  return (
    <Dialog
      open={pending != null}
      onOpenChange={(open) => {
        if (open) restoreFocusTo.current = document.activeElement as HTMLElement | null;
        else clear();
      }}
    >
      <DialogContent
        className="max-w-sm text-xs"
        onOpenAutoFocus={() => {
          restoreFocusTo.current = document.activeElement as HTMLElement | null;
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          restoreFocusTo.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">Publish branch to origin</DialogTitle>
          {target && (
            <DialogDescription asChild>
              <PublishBranchMessage branch={target.branch} />
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          <PublishBranchActions
            onCancel={clear}
            onConfirm={() => {
              clear();
              push.mutate();
            }}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
