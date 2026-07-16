import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, GitBranch, History, Tag as TagIcon } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ipc } from "@/lib/ipc";

/**
 * Read-only ref selector for the History view. Unlike the branch switcher this
 * performs **no checkout** — it only changes which ref's ancestry the log walks,
 * leaving `HEAD` and the working tree untouched (#254). `value` is the viewed
 * revspec (`null` = the checked-out `HEAD`); `onChange(null)` returns to HEAD.
 */
export function RefPicker({
  repoId,
  currentBranch,
  value,
  onChange,
}: {
  repoId: number;
  currentBranch?: string | null;
  value: string | null;
  onChange: (revspec: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  // Branch/tag lists load lazily, only while the popover is open. These reuse
  // the switcher's query keys so both stay in sync off one fetch.
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

  function pick(revspec: string | null) {
    onChange(revspec);
    setOpen(false);
    setFilter("");
  }

  const q = filter.toLowerCase();
  const branchList = (branches.data ?? [])
    .filter((b) => b.name.toLowerCase().includes(q))
    .sort((a, b) => Number(a.is_remote) - Number(b.is_remote));
  const tagList = (tags.data ?? []).filter((t) => t.toLowerCase().includes(q));
  const empty = branchList.length === 0 && tagList.length === 0;

  // What the trigger shows: the viewed ref, or the checked-out branch when on HEAD.
  const label = value ?? currentBranch ?? "HEAD";

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
          title="View another branch or tag's history (read-only)"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-accent)] data-[state=open]:bg-[var(--color-accent)]"
        >
          <History className="size-3 text-[var(--color-muted-foreground)]" />
          <span title={label} className="max-w-32 truncate">
            {label}
          </span>
          <ChevronDown className="size-2.5 opacity-60" />
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-72 p-0" align="start">
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
          {/* Return to the checked-out branch's history. */}
          <button
            onClick={() => pick(null)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-accent)]"
          >
            <span className="w-4 shrink-0">{value === null && <Check className="size-3.5" />}</span>
            <History className="size-3.5 shrink-0 text-[var(--color-muted-foreground)]" />
            <span className="min-w-0 flex-1 truncate text-xs">
              Current branch (HEAD)
              {currentBranch && (
                <span className="ml-1 font-mono text-[var(--color-muted-foreground)]">
                  {currentBranch}
                </span>
              )}
            </span>
          </button>

          {empty ? (
            <p className="p-3 text-center text-sm text-[var(--color-muted-foreground)]">
              No matching branches or tags.
            </p>
          ) : (
            <>
              {branchList.map((b) => (
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
              ))}

              {tagList.length > 0 && (
                <div className="border-t bg-[var(--color-sidebar)] px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
                  Tags
                </div>
              )}
              {tagList.map((t) => (
                <button
                  key={`t:${t}`}
                  onClick={() => pick(t)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-accent)]"
                >
                  <span className="w-4 shrink-0">
                    {value === t && <Check className="size-3.5" />}
                  </span>
                  <TagIcon className="size-3.5 shrink-0 text-[var(--color-muted-foreground)]" />
                  <span title={t} className="min-w-0 flex-1 truncate font-mono text-xs">
                    {t}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
