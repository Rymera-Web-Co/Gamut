import { useState } from "react";
import { GitBranch, GitCommitHorizontal, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { TimelineEvent } from "@/lib/ipc";
import { useUiStore } from "@/store/ui";
import { useBranches, useCheckoutPr } from "./api";

/** A grouped run of commits pushed to the PR branch (GitHub-style commit list). */
export function Commits({
  repoId,
  number,
  headRef,
  commits,
}: {
  repoId: number;
  number: number;
  headRef?: string;
  commits: TimelineEvent[];
}) {
  const branches = useBranches(repoId);
  const checkout = useCheckoutPr(repoId);
  const setView = useUiStore((s) => s.setView);
  const setHistorySha = useUiStore((s) => s.setHistorySha);
  const [confirmSha, setConfirmSha] = useState<string | null>(null);

  const isCheckedOut = !!(headRef && branches.data?.some((b) => b.name === headRef && b.is_head));
  // We can only offer checkout when we know the branch and it isn't current.
  const needsCheckout = !isCheckedOut && !!headRef;

  function open(sha: string) {
    setHistorySha(sha);
    setView("history");
  }

  function onRow(sha: string) {
    // When checked out (or we can't checkout), jump straight to History;
    // otherwise the row's popover handles confirmation.
    if (!needsCheckout) open(sha);
  }

  function confirmCheckout() {
    if (!confirmSha || !headRef) return;
    const sha = confirmSha;
    checkout.mutate(
      { number, headRef },
      {
        onSuccess: () => {
          setConfirmSha(null);
          open(sha);
        },
      },
    );
  }

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 border-b bg-[var(--color-sidebar)] px-3 py-1.5 text-xs text-[var(--color-muted-foreground)]">
        <GitCommitHorizontal className="size-4 shrink-0" />
        <span>
          added {commits.length} commit{commits.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="divide-y">
        {commits.map((c) => (
          <Popover
            key={c.sha}
            open={confirmSha === c.sha}
            onOpenChange={(o) => {
              if (needsCheckout) setConfirmSha(o ? c.sha! : null);
            }}
          >
            <PopoverTrigger asChild>
              <button
                onClick={() => onRow(c.sha!)}
                title={
                  needsCheckout
                    ? "Check out this branch to view the commit"
                    : "Open this commit in History"
                }
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-accent)]"
              >
                <GitCommitHorizontal className="size-3.5 shrink-0 text-[var(--color-muted-foreground)]" />
                <span className="min-w-0 flex-1 truncate">{c.message}</span>
                {c.actor && (
                  <span className="shrink-0 text-xs text-[var(--color-muted-foreground)]">
                    {c.actor}
                  </span>
                )}
                <code className="shrink-0 font-mono text-xs text-[var(--color-muted-foreground)]">
                  {c.short_sha}
                </code>
              </button>
            </PopoverTrigger>
            {needsCheckout && (
              <PopoverContent align="end" className="w-72 space-y-3 p-3">
                <p className="text-sm">
                  The branch <span className="font-mono font-medium">{headRef}</span> isn't checked
                  out. Check it out to view this commit in History?
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setConfirmSha(null)}>
                    Cancel
                  </Button>
                  <Button size="sm" disabled={checkout.isPending} onClick={confirmCheckout}>
                    {checkout.isPending ? <Loader2 className="animate-spin" /> : <GitBranch />}
                    Checkout
                  </Button>
                </div>
              </PopoverContent>
            )}
          </Popover>
        ))}
      </div>
    </div>
  );
}
