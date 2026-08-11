import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  GitBranch,
  GitBranchPlus,
  Loader2,
  Sparkles,
  Tag as TagIcon,
} from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ipc } from "@/lib/ipc";
import { useSettings } from "@/lib/settings";
import { useRepos } from "@/features/repos/api";
import { CleanupStaleDialog } from "./CleanupStaleDialog";

/** Sentinel `Select` value standing in for `sourceRef === ""` (base the new
 * branch on current HEAD) — Radix `Select.Item` rejects an empty-string value,
 * since it reserves "" internally to mean "no selection". */
const HEAD_SENTINEL = "__head__";

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
  // When true, the popover shows the "new branch" form instead of the picker.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  // "" means base the new branch on the current HEAD; otherwise an explicit ref.
  const [sourceRef, setSourceRef] = useState("");
  const [filter, setFilter] = useState("");
  // A fast checkout can flip `isPending` back before the browser paints, so the
  // in-progress state would never be seen. Hold it for a short minimum window so
  // the spinner/dim always shows at least briefly (#100).
  const [spinHold, setSpinHold] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(holdTimer.current ?? undefined), []);

  // Optimistic branch label. `currentBranch` comes from the all-repos
  // `repo-statuses` scan, which only refreshes on the debounced watcher round —
  // so the displayed name trails a switch by a beat. Show the picked target
  // immediately, then drop the override once the real status moves off whatever
  // it was when we started (handles both local checkouts and detached tags).
  const [optimisticBranch, setOptimisticBranch] = useState<string | null>(null);
  const branchAtMutate = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (optimisticBranch !== null && currentBranch !== branchAtMutate.current) {
      setOptimisticBranch(null);
    }
  }, [currentBranch, optimisticBranch]);

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

  // Optimistic-UI setup shared by checkout and create-and-checkout: close the
  // popover so the in-progress state shows on the branch field itself, and pin
  // the picked name as the displayed branch until the real status catches up.
  function beginSwitch(name: string) {
    setOpen(false);
    setCreating(false);
    setFilter("");
    setSpinHold(true);
    clearTimeout(holdTimer.current ?? undefined);
    holdTimer.current = setTimeout(() => setSpinHold(false), 500);
    branchAtMutate.current = currentBranch;
    setOptimisticBranch(name);
  }

  // Refresh just this repo's per-repo queries after HEAD moves. History's
  // `useLog` is keyed `["log", repoId, limit]`; the prefix match covers whatever
  // limit is loaded, and `refetchType: "all"` forces even momentarily-inactive
  // observers to swap to the new HEAD (#106). The all-repos `repo-statuses` scan
  // is left to the filesystem watcher's coalesced round (#100).
  function invalidateAfterBranchChange() {
    qc.invalidateQueries({ queryKey: ["branches", repoId] });
    qc.invalidateQueries({ queryKey: ["git-tags", repoId] });
    qc.invalidateQueries({ queryKey: ["log", repoId], refetchType: "all" });
    qc.invalidateQueries({ queryKey: ["review-files", repoId] });
  }

  const checkout = useMutation({
    mutationFn: (name: string) => ipc.checkoutBranch(repoId, name),
    // Errors surface via the global mutation toast.
    onMutate: (name: string) => beginSwitch(name),
    onError: () => {
      // The switch failed — drop the optimistic label so it reverts to reality.
      setOptimisticBranch(null);
    },
    onSuccess: invalidateAfterBranchChange,
  });

  const create = useMutation({
    mutationFn: ({ name, from }: { name: string; from?: string }) =>
      ipc.createBranch(repoId, name, from),
    // Optimistically show the new branch as current; the backend creates it from
    // HEAD (or `from`) and checks it out. Invalid/duplicate names are rejected by
    // the backend and surface via the global mutation toast.
    onMutate: ({ name }) => beginSwitch(name),
    onError: () => setOptimisticBranch(null),
    onSuccess: () => {
      setNewName("");
      setSourceRef("");
      invalidateAfterBranchChange();
    },
  });

  function submitCreate() {
    const name = newName.trim();
    if (!name) return;
    create.mutate({ name, from: sourceRef || undefined });
  }

  const q = filter.toLowerCase();
  const current =
    optimisticBranch ?? currentBranch ?? branches.data?.find((b) => b.is_head)?.name ?? "detached";
  const branchList = (branches.data ?? [])
    .filter((b) => b.name.toLowerCase().includes(q))
    .sort((a, b) => Number(a.is_remote) - Number(b.is_remote));
  const tagList = (tags.data ?? []).filter((t) => t.toLowerCase().includes(q));
  const empty = branchList.length === 0 && tagList.length === 0;

  // While a checkout runs, dim the field and swap the branch glyph for a spinner
  // (both size-3, so the row never reflows) so the switch reads as in-progress
  // even after the popover closes (#100).
  const switching = checkout.isPending || create.isPending || spinHold;

  // Local branches and tags the new branch can be based on (current HEAD is the
  // default, offered separately). Remote-tracking refs are valid revparse
  // targets too, so they're included. Deduped because a branch and tag can
  // share a name (e.g. `v1.0`), which would otherwise collide on the option key.
  const sourceOptions = Array.from(
    new Set([...(branches.data ?? []).map((b) => b.name), ...(tags.data ?? [])]),
  );

  // The repo's base branch, used as the default source for a new branch — you
  // usually branch off main, not off whatever happens to be checked out. Prefer
  // the repo's recorded default branch, then the configured base-branch
  // precedence (trunk/main/master), restricted to branches that actually exist
  // locally. Falls back to "" (current HEAD) when none match.
  const baseBranchPrecedence = useSettings((s) => s.values.baseBranchPrecedence);
  const repos = useRepos();
  const baseBranch = (() => {
    const local = new Set((branches.data ?? []).filter((b) => !b.is_remote).map((b) => b.name));
    const repoDefault = repos.data?.find((r) => r.id === repoId)?.default_branch ?? null;
    const candidates = [
      repoDefault,
      ...baseBranchPrecedence.split(",").map((s) => s.trim()),
    ].filter((s): s is string => !!s);
    return candidates.find((name) => local.has(name)) ?? "";
  })();

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setCreating(false);
            setFilter("");
          }
        }}
      >
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
            <span title={current} className="max-w-28 truncate">
              {current}
            </span>
            <ChevronDown className="size-2.5 opacity-60" />
          </button>
        </PopoverTrigger>

        <PopoverContent className="w-72 p-0">
          {creating ? (
            <form
              className="space-y-2 p-2"
              onSubmit={(e) => {
                e.preventDefault();
                submitCreate();
              }}
            >
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
                New branch
              </div>
              <Input
                autoFocus
                placeholder="branch-name"
                value={newName}
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setCreating(false);
                  }
                }}
                className="h-8 font-mono text-xs"
              />
              {/* `aria-labelledby` rather than a bare <label>: the trigger is a
                  button, so nothing tied the visible label to it — screen
                  readers announced the control unnamed. */}
              <label
                id="branch-source-label"
                className="block text-[10px] font-medium text-[var(--color-muted-foreground)]"
              >
                Base it on
              </label>
              <Select
                value={sourceRef || HEAD_SENTINEL}
                onValueChange={(v) => setSourceRef(v === HEAD_SENTINEL ? "" : v)}
              >
                <SelectTrigger
                  aria-labelledby="branch-source-label"
                  className="w-full font-mono text-xs hover:bg-[var(--color-accent)]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="font-mono text-xs">
                  <SelectItem value={HEAD_SENTINEL}>Current branch (HEAD)</SelectItem>
                  {sourceOptions.map((ref) => (
                    <SelectItem key={ref} value={ref}>
                      {ref}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  className="rounded px-2 py-1 text-xs text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!newName.trim() || create.isPending}
                  className="rounded bg-[var(--color-primary)] px-2 py-1 text-xs font-medium text-[var(--color-primary-foreground)] hover:opacity-90 disabled:opacity-40"
                >
                  Create branch
                </button>
              </div>
            </form>
          ) : (
            <>
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
                        disabled={checkout.isPending}
                        onClick={() => checkout.mutate(t)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-accent)]"
                      >
                        <span className="w-4 shrink-0" />
                        <TagIcon className="size-3.5 shrink-0 text-[var(--color-muted-foreground)]" />
                        <span title={t} className="min-w-0 flex-1 truncate font-mono text-xs">
                          {t}
                        </span>
                      </button>
                    ))}
                  </>
                )}
              </div>
              <button
                onClick={() => {
                  setNewName(filter);
                  // Default the source to the repo's base branch (#131 follow-up).
                  setSourceRef(baseBranch);
                  setCreating(true);
                }}
                className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-xs text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)]"
              >
                <GitBranchPlus className="size-3.5 shrink-0" />
                Create branch…
              </button>
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
            </>
          )}
        </PopoverContent>
      </Popover>

      <CleanupStaleDialog repoId={repoId} open={cleanupOpen} onOpenChange={setCleanupOpen} />
    </>
  );
}
