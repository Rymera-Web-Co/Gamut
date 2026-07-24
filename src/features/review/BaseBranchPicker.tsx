import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, GitBranch, Wand2 } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ipc } from "@/lib/ipc";

/**
 * Base-branch selector for "Branch vs base" review (#281, subtask st_761). Lets
 * the user override which branch the current branch is diffed against. `value` is
 * the chosen override (`null` = Auto: the matched PR's base branch, else the
 * backend's default precedence). No checkout happens — it only changes the diff
 * base. The `origin/`-fallback in the backend means either a local branch name
 * or its `origin/<name>` counterpart resolves.
 */
export function BaseBranchPicker({
  repoId,
  value,
  autoLabel,
  onChange,
}: {
  repoId: number;
  value: string | null;
  /** What "Auto" currently resolves to (the matched PR's base), for display. */
  autoLabel?: string;
  onChange: (base: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  // Branch list loads lazily while the popover is open; reuses the shared
  // ["branches", repoId] query key so it stays in sync off one fetch.
  const branches = useQuery({
    queryKey: ["branches", repoId],
    queryFn: () => ipc.listBranches(repoId),
    enabled: open,
  });

  function pick(base: string | null) {
    onChange(base);
    setOpen(false);
    setFilter("");
  }

  const q = filter.toLowerCase();
  const branchList = (branches.data ?? [])
    // Drop `origin/HEAD` and friends — a symbolic pseudo-ref, not a real base.
    .filter((b) => !b.name.endsWith("/HEAD"))
    .filter((b) => b.name.toLowerCase().includes(q))
    .sort((a, b) => Number(a.is_remote) - Number(b.is_remote));

  // The trigger shows the override, or the auto-resolved base when on Auto.
  const label = value ?? autoLabel ?? "Auto";

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFilter("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          title="Choose which branch to diff against"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-accent)] data-[state=open]:bg-[var(--color-accent)]"
        >
          <span className="text-[var(--color-muted-foreground)]">base:</span>
          <span title={label} className="max-w-32 truncate font-mono">
            {label}
          </span>
          <ChevronDown className="size-2.5 opacity-60" />
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-72 p-0" align="end">
        <div className="p-2">
          <Input
            autoFocus
            placeholder="Filter branches…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8"
          />
        </div>
        <div className="max-h-72 overflow-auto border-t">
          {/* Back to the auto base (matched PR's base, else default precedence). */}
          <button
            onClick={() => pick(null)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-accent)]"
          >
            <span className="w-4 shrink-0">{value === null && <Check className="size-3.5" />}</span>
            <Wand2 className="size-3.5 shrink-0 text-[var(--color-muted-foreground)]" />
            <span className="min-w-0 flex-1 truncate text-xs">
              Auto
              {autoLabel && (
                <span className="ml-1 font-mono text-[var(--color-muted-foreground)]">
                  {autoLabel}
                </span>
              )}
            </span>
          </button>

          {branchList.length === 0 ? (
            <p className="p-3 text-center text-sm text-[var(--color-muted-foreground)]">
              No matching branches.
            </p>
          ) : (
            branchList.map((b) => (
              <button
                key={`${b.is_remote ? "r" : "l"}:${b.name}`}
                onClick={() => pick(b.name)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-accent)]"
              >
                <span className="w-4 shrink-0">
                  {value === b.name && <Check className="size-3.5" />}
                </span>
                <GitBranch className="size-3.5 shrink-0 text-[var(--color-muted-foreground)]" />
                <span title={b.name} className="min-w-0 flex-1 truncate font-mono text-xs">
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
      </PopoverContent>
    </Popover>
  );
}
