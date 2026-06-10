import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, GitBranch, Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";

export function BranchSwitcher({ repoId }: { repoId: number }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const branches = useQuery({
    queryKey: ["branches", repoId],
    queryFn: () => ipc.listBranches(repoId),
  });

  const checkout = useMutation({
    mutationFn: (name: string) => ipc.checkoutBranch(repoId, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["branches", repoId] });
      qc.invalidateQueries({ queryKey: ["log", repoId] });
      qc.invalidateQueries({ queryKey: ["review-files", repoId] });
      qc.invalidateQueries({ queryKey: ["repos"] });
      setOpen(false);
      setFilter("");
    },
  });

  const current = branches.data?.find((b) => b.is_head)?.name ?? "detached";
  const list = (branches.data ?? [])
    .filter((b) => b.name.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => Number(a.is_remote) - Number(b.is_remote));

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Switch branch"
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
      >
        <GitBranch className="size-3.5" />
        <span className="max-w-40 truncate font-medium">{current}</span>
        <ChevronDown className="size-3" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md gap-2">
          <DialogHeader>
            <DialogTitle className="text-sm">Switch branch</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Filter branches…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {checkout.isError && (
            <p className="text-xs text-[var(--color-destructive)]">
              {String(checkout.error)}
            </p>
          )}
          <div className="max-h-80 overflow-auto rounded-md border">
            {list.length === 0 ? (
              <p className="p-3 text-center text-sm text-[var(--color-muted-foreground)]">
                No matching branches.
              </p>
            ) : (
              list.map((b) => (
                <button
                  key={`${b.is_remote ? "r" : "l"}:${b.name}`}
                  disabled={checkout.isPending}
                  onClick={() => checkout.mutate(b.name)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
                    "hover:bg-[var(--color-accent)]",
                  )}
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
              ))
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
