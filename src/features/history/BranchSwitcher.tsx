import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, GitBranch, Loader2, Sparkles, Tag as TagIcon } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ipc } from "@/lib/ipc";
import { CleanupStaleDialog } from "./CleanupStaleDialog";

export function BranchSwitcher({
  repoId,
  currentBranch,
}: {
  repoId: number;
  currentBranch?: string | null;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [filter, setFilter] = useState("");
  // A fast checkout can flip `isPending` back before the browser paints, so the
  // in-progress state would never be seen. Hold it for a short minimum window so
  // the spinner/dim always shows at least briefly (#100).
  const [spinHold, setSpinHold] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(holdTimer.current ?? undefined), []);

  // Branch/tag lists are only needed when the dropdown is open, so they load
  // lazily — keeps the repo list cheap when many rows each have a switcher.
  const branches = useQuery({
    queryKey: ["branches", repoId],
    queryFn: () => ipc.listBranches(repoId),
    enabled: open,
  });
  const tags = useQuery({
    queryKey: ["git-tags", repoId],
    queryFn: () => ipc.listGitTags(repoId),
    enabled: open,
  });

  const checkout = useMutation({
    mutationFn: (name: string) => ipc.checkoutBranch(repoId, name),
    // Close the dropdown as soon as a target is picked so the in-progress state
    // shows on the branch field itself (the checkout can take a moment). Errors
    // surface via the global mutation toast.
    onMutate: () => {
      setOpen(false);
      setFilter("");
      setSpinHold(true);
      clearTimeout(holdTimer.current ?? undefined);
      holdTimer.current = setTimeout(() => setSpinHold(false), 500);
    },
    onSuccess: () => {
      // Per-repo, cheaply-keyed queries — refresh just this repo immediately.
      qc.invalidateQueries({ queryKey: ["branches", repoId] });
      qc.invalidateQueries({ queryKey: ["git-tags", repoId] });
      qc.invalidateQueries({ queryKey: ["log", repoId] });
      qc.invalidateQueries({ queryKey: ["review-files", repoId] });
      // The all-repos `repo-statuses` scan is left to the filesystem watcher's
      // single coalesced `repos-changed` round — a checkout moves HEAD, which the
      // watcher always sees. Invalidating it here too would stage a second,
      // redundant scan of every registered repo for a single-repo switch (#100).
    },
  });

  const q = filter.toLowerCase();
  const current = currentBranch ?? branches.data?.find((b) => b.is_head)?.name ?? "detached";
  const branchList = (branches.data ?? [])
    .filter((b) => b.name.toLowerCase().includes(q))
    .sort((a, b) => Number(a.is_remote) - Number(b.is_remote));
  const tagList = (tags.data ?? []).filter((t) => t.toLowerCase().includes(q));
  const empty = branchList.length === 0 && tagList.length === 0;

  // While a checkout runs, dim the field and swap the branch glyph for a spinner
  // (both size-3, so the row never reflows) so the switch reads as in-progress
  // even after the popover closes (#100).
  const switching = checkout.isPending || spinHold;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            title="Switch branch or tag"
            aria-busy={switching}
            className={`flex items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-accent)] data-[state=open]:bg-[var(--color-accent)] ${
              switching ? "pointer-events-none opacity-60" : ""
            }`}
          >
            {switching ? (
              <Loader2 className="size-3 animate-spin text-[var(--color-muted-foreground)]" />
            ) : (
              <GitBranch className="size-3 text-[var(--color-muted-foreground)]" />
            )}
            <span className="max-w-28 truncate">{current}</span>
            <ChevronDown className="size-2.5 opacity-60" />
          </button>
        </PopoverTrigger>

        <PopoverContent className="w-72 p-0">
          <div className="p-2">
            <Input
              autoFocus
              placeholder="Filter branches and tags…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-8"
            />
          </div>
          <div className="max-h-72 overflow-auto border-t">
            {empty ? (
              <p className="p-3 text-center text-sm text-[var(--color-muted-foreground)]">
                No matching branches or tags.
              </p>
            ) : (
              <>
                {branchList.map((b) => (
                  <button
                    key={`${b.is_remote ? "r" : "l"}:${b.name}`}
                    disabled={checkout.isPending}
                    onClick={() => checkout.mutate(b.name)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-accent)]"
                  >
                    <span className="w-4 shrink-0">
                      {b.is_head && <Check className="size-3.5" />}
                    </span>
                    <GitBranch className="size-3.5 shrink-0 text-[var(--color-muted-foreground)]" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{b.name}</span>
                    {b.is_remote && (
                      <span className="shrink-0 text-[10px] text-[var(--color-muted-foreground)]">
                        remote
                      </span>
                    )}
                  </button>
                ))}

                {tagList.length > 0 && (
                  <div className="border-t bg-[var(--color-sidebar)] px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
                    Tags
                  </div>
                )}
                {tagList.map((t) => (
                  <button
                    key={`t:${t}`}
                    disabled={checkout.isPending}
                    onClick={() => checkout.mutate(t)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-accent)]"
                  >
                    <span className="w-4 shrink-0" />
                    <TagIcon className="size-3.5 shrink-0 text-[var(--color-muted-foreground)]" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{t}</span>
                  </button>
                ))}
              </>
            )}
          </div>
          <button
            onClick={() => {
              setOpen(false);
              setFilter("");
              setCleanupOpen(true);
            }}
            className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-xs text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)]"
          >
            <Sparkles className="size-3.5 shrink-0" />
            Clean up stale branches…
          </button>
        </PopoverContent>
      </Popover>

      <CleanupStaleDialog repoId={repoId} open={cleanupOpen} onOpenChange={setCleanupOpen} />
    </>
  );
}
