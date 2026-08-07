import { Button } from "@/components/ui/button";

/**
 * The question behind the first-publish guard (#300), split so both entry points
 * can wrap it in their own shell — the popover anchored to a row's push button,
 * and the dialog the ⌘⇧K shortcut raises — without the wording or the actions
 * drifting apart between them.
 *
 * The copy says what the push will *do* rather than asserting the branch is
 * absent from the remote: a branch can have no upstream while `origin` already
 * has one of that name (`--no-track`, or a colleague pushing it first).
 *
 * Props are spread so the dialog can render this as its `DialogDescription`
 * (via `asChild`), which is what gets announced with the dialog's title.
 */
export function PublishBranchMessage({
  branch,
  ...props
}: { branch: string } & React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className="text-[var(--color-muted-foreground)]" {...props}>
      <span className="font-medium text-[var(--color-foreground)]">{branch}</span> has no upstream
      yet. Push it to <span className="font-medium text-[var(--color-foreground)]">origin</span> and
      track it from there?
    </p>
  );
}

/**
 * Cancel / confirm for {@link PublishBranchMessage}. "Publish branch", not
 * "create branch" — in a git client the latter reads as the local operation the
 * branch switcher does, and this one pushes.
 */
export function PublishBranchActions({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex justify-end gap-1.5">
      <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={onCancel}>
        Cancel
      </Button>
      <Button size="sm" className="h-6 text-xs" onClick={onConfirm}>
        Publish branch
      </Button>
    </div>
  );
}
