import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  GitBranch,
  Loader2,
  Tag as TagIcon,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ipc } from "@/lib/ipc";

export function BranchSwitcher({
  repoId,
  currentBranch,
}: {
  repoId: number;
  currentBranch?: string | null;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["branches", repoId] });
      qc.invalidateQueries({ queryKey: ["git-tags", repoId] });
      qc.invalidateQueries({ queryKey: ["log", repoId] });
      qc.invalidateQueries({ queryKey: ["review-files", repoId] });
      qc.invalidateQueries({ queryKey: ["repos"] });
      qc.invalidateQueries({ queryKey: ["repo-statuses"] });
      setOpen(false);
      setFilter("");
    },
  });

  const q = filter.toLowerCase();
  const current =
    currentBranch ?? branches.data?.find((b) => b.is_head)?.name ?? "detached";
  const branchList = (branches.data ?? [])
    .filter((b) => b.name.toLowerCase().includes(q))
    .sort((a, b) => Number(a.is_remote) - Number(b.is_remote));
  const tagList = (tags.data ?? []).filter((t) => t.toLowerCase().includes(q));
  const empty = branchList.length === 0 && tagList.length === 0;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Switch branch or tag"
        className="flex items-center gap-1 rounded bg-[#2563eb] px-1.5 py-0.5 text-[11px] font-medium text-white shadow-sm transition-colors hover:bg-[#1d4ed8]"
      >
        <GitBranch className="size-3" />
        <span className="max-w-28 truncate">{current}</span>
        <ChevronDown className="size-2.5 opacity-80" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md gap-2">
          <DialogHeader>
            <DialogTitle className="text-sm">Switch branch or tag</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Filter branches and tags…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {checkout.isError && (
            <p className="text-xs text-[var(--color-destructive)]">
              {String(checkout.error)}
            </p>
          )}
          <div className="max-h-80 overflow-auto rounded-md border">
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
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {b.name}
                    </span>
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
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {t}
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
          {checkout.isPending && (
            <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
              <Loader2 className="size-3.5 animate-spin" /> Checking out…
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
