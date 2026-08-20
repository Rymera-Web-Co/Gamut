import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, GitBranchPlus, RotateCcw, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ipc,
  pickDirectory,
  type ConfigOverview,
  type IdentityFieldName,
  type IdentityValue,
  type LinkedWorktree,
} from "@/lib/ipc";
import {
  Divider,
  Field,
  PanelTitle,
  Segmented,
  Select,
  TextField,
  Toggle,
} from "@/features/settings/controls";
import { toast } from "@/store/toast";
import { useRegisterRepo, useRepos } from "./api";
import { ConfirmDeleteBranchDialog } from "./ConfirmDeleteBranchDialog";
import { ConfirmRemoveWorktreeDialog } from "./ConfirmRemoveWorktreeDialog";

/** Sentinel `<select>` value for "no upstream configured" — never a legal
 * `remote/branch` shorthand, so it can't collide with a real remote-tracking
 * branch name. */
const NO_UPSTREAM = "__none__";

/** The per-field source note next to each identity editor: distinguishes
 * "nothing configured anywhere", "set at local scope (this repo)", and
 * "inherited from a higher scope" so clearing vs. leaving alone is informed. */
function identityHint(v: IdentityValue): string {
  if (v.value == null) return "Not set";
  if (v.local_value != null) return "Set here (local)";
  return `Inherited from ${v.level ?? "another scope"}`;
}

/** `branch.<n>.merge` is a full ref (`refs/heads/main`); the upstream picker
 * works in the same `remote/branch` shorthand `remote_branches` uses. */
function upstreamShorthand(remote: string | null, merge: string | null): string | null {
  if (!remote || !merge) return null;
  return `${remote}/${merge.replace(/^refs\/heads\//, "")}`;
}

/** The leaf directory name for a new worktree: `<repo name>-<branch>`, with
 * path separators in the branch name flattened so a nested branch (`feat/x`)
 * can't spell a `feat/` subdirectory the user didn't ask for. Shared by the
 * sibling-directory default and the "Browse…" folder picker, so both name a
 * new worktree the same way. */
function worktreeLeafName(repoName: string, branch: string): string {
  const safeBranch = branch.trim().replace(/[\\/]+/g, "-") || "new-worktree";
  return `${repoName}-${safeBranch}`;
}

/** The sibling-directory default for "Add worktree…": `<repo's parent
 * dir>/<repo name>-<branch>`. */
function siblingWorktreePath(repoPath: string, repoName: string, branch: string): string {
  const parent = repoPath.replace(/\/[^/]*\/?$/, "") || "/";
  return `${parent}/${worktreeLeafName(repoName, branch)}`;
}

/** Local-branch delete refusals: the current-branch/protected-branch case has
 * its own confirmation UI (`ConfirmDeleteBranchDialog` reads `merged` up
 * front), but a worktree-remove refusal only ever surfaces here, at catch
 * time — matched against the backend's dirty-worktree wording so any other
 * failure (a locked worktree, a permissions error, …) just shows the plain
 * error toast instead of offering a force option that can't possibly help. */
const WORKTREE_DIRTY_ERROR = /uncommitted|contains modified or untracked files/i;

/**
 * The config viewer + curated editor for one repo, rendered inside
 * `RepoConfigDialog` (#306 follow-up — this used to be a Settings panel
 * reading `activeRepoId`; it now takes an explicit `repoId` prop so opening
 * it never changes which repo is selected elsewhere in the app).
 */
export function RepoConfigPanel({ repoId }: { repoId: number }) {
  const repos = useRepos();
  // The dialog only ever opens for a repo that's a known git repo at the time
  // of the click, so this is a late guard, not the common path: it catches the
  // repo being removed (or turning out not to be git) while the dialog stays
  // open. While the repo list is still loading, `repos.data` is `undefined` —
  // treated as "not yet known" rather than "gone", so this doesn't flash the
  // guard for a repo that's about to resolve.
  const repo = repos.data?.find((r) => r.id === repoId);
  const notFound = repos.data != null && (repo == null || !repo.is_git_repo);

  const [overview, setOverview] = useState<ConfigOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [emailValue, setEmailValue] = useState("");
  const [remoteValues, setRemoteValues] = useState<Record<string, string>>({});
  const [branch, setBranch] = useState("");

  // Linked worktrees (main excluded), fetched in this panel's own refresh
  // cycle (not the sidebar's react-query `useLinkedWorktrees`) so one Refresh
  // button governs the whole panel.
  const [worktrees, setWorktrees] = useState<LinkedWorktree[]>([]);
  const qc = useQueryClient();
  const registerRepo = useRegisterRepo();

  // "New branch…" (Branches section).
  const [newBranchName, setNewBranchName] = useState("");
  const [newBranchBase, setNewBranchBase] = useState("");
  const [newBranchSwitch, setNewBranchSwitch] = useState(false);

  // Inline rename (Branches section): the branch currently being renamed, if any.
  const [renamingBranch, setRenamingBranch] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Branch-delete confirmation. `merged` is known up front from the row, so
  // the escalated variant renders directly rather than reacting to a refusal.
  const [deleteBranchTarget, setDeleteBranchTarget] = useState<{
    name: string;
    merged: boolean;
  } | null>(null);

  // "Add worktree…" (Worktrees section).
  const [addWtPath, setAddWtPath] = useState("");
  const [addWtPathTouched, setAddWtPathTouched] = useState(false);
  const [addWtMode, setAddWtMode] = useState<"existing" | "new">("existing");
  const [addWtBranch, setAddWtBranch] = useState("");
  const [addWtNewBranchName, setAddWtNewBranchName] = useState("");

  // Worktree-remove confirmation. Unlike branch delete, "dirty" isn't known
  // up front — `escalated` flips to true only after the backend refuses a
  // plain remove with the dirty-worktree error. `locked` is known up front
  // from the row and suppresses that escalation: a locked worktree needs
  // unlocking first (out of scope), so any failure there just shows a plain
  // error toast.
  const [removeWorktreeTarget, setRemoveWorktreeTarget] = useState<{
    path: string;
    escalated: boolean;
    locked: boolean;
  } | null>(null);

  // Bumped on every `refresh()` call; a response is applied only if it's still
  // the most recent one when it lands. Without this, a slow response for a
  // previous repo (or an earlier overlapping Refresh click) can resolve after
  // a newer one and overwrite the current repo's state with stale data — a
  // subsequent blur would then write the stale remote's URL into the
  // *current* repo's `.git/config`.
  const generationRef = useRef(0);

  // Re-read from disk and reset every unsaved draft to what's actually stored
  // — used for the mount load, the Refresh button (A8), after every
  // successful write (A24), and whenever `repoId` changes (A10, via the
  // effect below), so a previous repo's unsaved edit never carries over.
  //
  // Exception: a field the user is actively typing into (has DOM focus) right
  // now is left alone. `refresh()` runs after every write, so committing Name
  // must not blow away whatever's mid-edit in Email — comparing against
  // `document.activeElement` at response time is simpler to reason about than
  // trying to track "written vs. untouched" per field.
  const refresh = useCallback(() => {
    const generation = (generationRef.current += 1);
    setLoading(true);
    Promise.all([
      ipc.gitConfigOverview(repoId),
      // A worktree-list failure must not sink the whole refresh (the config
      // half is the more important read) — fall back to an empty list.
      ipc.gitWorktreeList(repoId).catch(() => [] as LinkedWorktree[]),
    ])
      .then(([ov, wts]) => {
        if (generationRef.current !== generation) return;
        setOverview(ov);
        // Defends against a backend/mock that resolves with no value at all
        // (rather than rejecting), not just a genuine fetch failure.
        setWorktrees(Array.isArray(wts) ? wts.filter((w) => !w.is_main) : []);

        const focusedLabel = document.activeElement?.getAttribute("aria-label");
        if (focusedLabel !== "user.name") {
          setNameValue(ov.identity.name.value ?? "");
        }
        if (focusedLabel !== "user.email") {
          setEmailValue(ov.identity.email.value ?? "");
        }
        setRemoteValues((prev) => {
          const next = Object.fromEntries(ov.remotes.map((r) => [r.name, r.url]));
          const focusedRemote = focusedLabel?.endsWith(" URL")
            ? focusedLabel.slice(0, -" URL".length)
            : null;
          if (focusedRemote != null && focusedRemote in next) {
            next[focusedRemote] = prev[focusedRemote] ?? next[focusedRemote];
          }
          return next;
        });

        setBranch((prev) => {
          if (ov.branches.some((b) => b.name === prev)) return prev;
          return ov.branches.find((b) => b.is_head)?.name ?? ov.branches[0]?.name ?? "";
        });
        const currentBranchName =
          ov.branches.find((b) => b.is_head)?.name ?? ov.branches[0]?.name ?? "";
        // "New branch…" base and the worktree form's existing-branch picker
        // both default to the current branch (A3) — reset only when the prior
        // selection no longer names a real branch, same rule as `branch` above.
        setNewBranchBase((prev) =>
          ov.branches.some((b) => b.name === prev) ? prev : currentBranchName,
        );
        setAddWtBranch((prev) =>
          ov.branches.some((b) => b.name === prev) ? prev : currentBranchName,
        );
      })
      .catch(() => {
        if (generationRef.current !== generation) return;
        toast.error("Could not load git config");
      })
      .finally(() => {
        if (generationRef.current !== generation) return;
        setLoading(false);
      });
  }, [repoId]);

  useEffect(() => {
    if (notFound) {
      setOverview(null);
      return;
    }
    refresh();
    // Only re-run on repo/not-found changes, not on every `refresh` identity
    // change (it already depends on `repoId`, which is in this list).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, notFound]);

  // Refresh the per-repo queries that a branch/worktree mutation here can
  // affect, mirroring the house rule `BranchSwitcher`/`CleanupStaleDialog`
  // already follow for HEAD-moving actions: history's branch/tag pickers,
  // the log (`refetchType: "all"` so even a momentarily-inactive observer
  // swaps to the new state), and the review-files list, plus the sidebar's
  // repo list and linked-worktree count for anything that adds/removes a
  // worktree or renames/deletes a branch out from under it. Hooks must run
  // unconditionally, so this (and `registeredWorktreePaths` below) live above
  // the `notFound` early return even though nothing else this early needs them.
  const invalidateAfterRepoMutation = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["branches", repoId] });
    qc.invalidateQueries({ queryKey: ["git-tags", repoId] });
    qc.invalidateQueries({ queryKey: ["log", repoId], refetchType: "all" });
    qc.invalidateQueries({ queryKey: ["review-files", repoId] });
    qc.invalidateQueries({ queryKey: ["linked-worktrees", repoId] });
    qc.invalidateQueries({ queryKey: ["repos"] });
  }, [qc, repoId]);

  if (notFound) {
    // No heading here: the dialog's own header already names what's gone.
    return (
      <p className="text-xs text-[var(--color-muted-foreground)]">
        This repository is no longer available.
      </p>
    );
  }

  const commitName = async () => {
    const trimmed = nameValue.trim();
    // The field is prefilled with the *effective* value, which may be
    // inherited from global. Merely focusing and leaving it (no actual edit)
    // must not write that inherited value into local scope — that would flip
    // "Inherited from global" to "Set here (local)" with no user intent.
    if (trimmed === (overview?.identity.name.value ?? "")) return;
    try {
      await ipc.gitConfigSetIdentity(repoId, "name", trimmed === "" ? null : trimmed);
      refresh();
    } catch (e) {
      toast.error(String(e));
      setNameValue(overview?.identity.name.value ?? "");
    }
  };

  const commitEmail = async () => {
    const trimmed = emailValue.trim();
    if (trimmed === (overview?.identity.email.value ?? "")) return;
    try {
      await ipc.gitConfigSetIdentity(repoId, "email", trimmed === "" ? null : trimmed);
      refresh();
    } catch (e) {
      toast.error(String(e));
      setEmailValue(overview?.identity.email.value ?? "");
    }
  };

  const clearIdentity = async (field: IdentityFieldName) => {
    try {
      await ipc.gitConfigSetIdentity(repoId, field, null);
      refresh();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const commitRemote = async (name: string) => {
    const value = remoteValues[name] ?? "";
    const trimmed = value.trim();
    // Same guard as identity (see `commitName`): don't resave an untouched
    // field just because it was focused and blurred.
    if (trimmed === (overview?.remotes.find((r) => r.name === name)?.url ?? "")) return;
    try {
      await ipc.gitConfigSetRemoteUrl(repoId, name, trimmed);
      refresh();
    } catch (e) {
      toast.error(String(e));
      const reverted = overview?.remotes.find((r) => r.name === name)?.url ?? "";
      setRemoteValues((prev) => ({ ...prev, [name]: reverted }));
    }
  };

  const onUpstreamChange = async (value: string) => {
    try {
      await ipc.gitConfigSetBranchUpstream(repoId, branch, value === NO_UPSTREAM ? null : value);
      refresh();
    } catch (e) {
      // No local draft to revert: the picker's value is derived straight from
      // `overview`, which a failed write leaves untouched, so the display
      // already stays honest without extra state (A25).
      toast.error(String(e));
    }
  };

  const selectedBranch = overview?.branches.find((b) => b.name === branch) ?? null;
  const currentUpstream = selectedBranch
    ? (upstreamShorthand(selectedBranch.remote, selectedBranch.merge) ?? NO_UPSTREAM)
    : NO_UPSTREAM;

  // ---- Branches section ----------------------------------------------------

  const switchBranch = async (name: string) => {
    try {
      await ipc.checkoutBranch(repoId, name);
      invalidateAfterRepoMutation();
      refresh();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const submitNewBranch = async () => {
    const name = newBranchName.trim();
    if (!name) return;
    try {
      await ipc.gitBranchCreate(repoId, name, newBranchBase || undefined, newBranchSwitch);
      setNewBranchName("");
      invalidateAfterRepoMutation();
      refresh();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const startRename = (name: string) => {
    setRenamingBranch(name);
    setRenameValue(name);
  };

  const cancelRename = () => {
    setRenamingBranch(null);
    setRenameValue("");
  };

  const submitRename = async () => {
    if (!renamingBranch) return;
    const newName = renameValue.trim();
    if (!newName || newName === renamingBranch) {
      cancelRename();
      return;
    }
    try {
      await ipc.renameBranch(repoId, renamingBranch, newName);
      cancelRename();
      invalidateAfterRepoMutation();
      refresh();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const confirmDeleteBranch = async (force: boolean) => {
    if (!deleteBranchTarget) return;
    const { name } = deleteBranchTarget;
    setDeleteBranchTarget(null);
    try {
      await ipc.deleteLocalBranch(repoId, name, force);
      invalidateAfterRepoMutation();
      refresh();
    } catch (e) {
      toast.error(String(e));
    }
  };

  // ---- Worktrees section -----------------------------------------------------

  const branchForAddWtDefaultPath = addWtMode === "existing" ? addWtBranch : addWtNewBranchName;
  const addWtPathValue = addWtPathTouched
    ? addWtPath
    : repo
      ? siblingWorktreePath(repo.path, repo.name, branchForAddWtDefaultPath)
      : "";

  const submitAddWorktree = async () => {
    const path = addWtPathValue.trim();
    const branchName = (addWtMode === "existing" ? addWtBranch : addWtNewBranchName).trim();
    if (!path || !branchName) return;
    try {
      await ipc.gitWorktreeAdd(repoId, path, branchName, addWtMode === "new");
      setAddWtPath("");
      setAddWtPathTouched(false);
      setAddWtNewBranchName("");
      invalidateAfterRepoMutation();
      refresh();
    } catch (e) {
      toast.error(String(e));
    }
  };

  /** "Browse…" beside the worktree path field: on a picked directory, fill
   * the field with `<dir>/<repo>-<branch>` — the same leaf name the
   * sibling-directory default uses — and mark it user-touched so the default
   * stops overwriting it. */
  const chooseWorktreeFolder = async () => {
    const dir = await pickDirectory("Choose a location for the worktree");
    if (!dir || !repo) return;
    setAddWtPath(`${dir}/${worktreeLeafName(repo.name, branchForAddWtDefaultPath)}`);
    setAddWtPathTouched(true);
  };

  const confirmRemoveWorktree = async (force: boolean) => {
    if (!removeWorktreeTarget) return;
    const { path, locked } = removeWorktreeTarget;
    try {
      await ipc.gitWorktreeRemove(repoId, path, force);
      setRemoveWorktreeTarget(null);
      invalidateAfterRepoMutation();
      refresh();
    } catch (e) {
      const message = String(e);
      toast.error(message);
      // Escalate to the force-offering dialog only for an actual dirty-
      // worktree refusal on a first attempt — never for a locked worktree
      // (needs unlocking first, out of scope) and never once `force` was
      // already tried (nothing stronger to offer).
      if (force || locked || !WORKTREE_DIRTY_ERROR.test(message)) {
        setRemoveWorktreeTarget(null);
        return;
      }
      setRemoveWorktreeTarget({ path, escalated: true, locked });
    }
  };

  const registerWorktree = async (path: string) => {
    try {
      await registerRepo.mutateAsync(path);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const pruneWorktrees = async () => {
    try {
      await ipc.gitWorktreePrune(repoId);
      toast.success("Pruned stale worktree entries");
      invalidateAfterRepoMutation();
      refresh();
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <div>
      {/* No top-level heading: the dialog header already names the repo this
          is for. The section headings below carry the structure. */}
      <p className="mb-2 text-xs text-[var(--color-muted-foreground)]">
        The effective git config for this repository — every layer it's assembled from, plus a
        curated set of fields you can edit. Edits are always written at local scope (this repo's{" "}
        <code>.git/config</code>), never global or system.
      </p>

      <div className="mb-3 flex gap-2">
        <Button variant="outline" size="sm" className="h-8" onClick={refresh} disabled={loading}>
          <RotateCcw className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {overview && (
        <>
          <PanelTitle>Identity</PanelTitle>
          <Field label="Name" hint={identityHint(overview.identity.name)}>
            <div className="flex items-center gap-2">
              <TextField
                ariaLabel="user.name"
                value={nameValue}
                onChange={setNameValue}
                onBlur={() => void commitName()}
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs"
                disabled={overview.identity.name.local_value == null}
                onClick={() => void clearIdentity("name")}
              >
                Clear
              </Button>
            </div>
          </Field>
          <Field label="Email" hint={identityHint(overview.identity.email)}>
            <div className="flex items-center gap-2">
              <TextField
                ariaLabel="user.email"
                value={emailValue}
                onChange={setEmailValue}
                onBlur={() => void commitEmail()}
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs"
                disabled={overview.identity.email.local_value == null}
                onClick={() => void clearIdentity("email")}
              >
                Clear
              </Button>
            </div>
          </Field>

          <Divider />
          <PanelTitle>Remotes</PanelTitle>
          {overview.remotes.length === 0 ? (
            <p className="text-xs text-[var(--color-muted-foreground)]">No remotes configured.</p>
          ) : (
            overview.remotes.map((r) => (
              <Field key={r.name} label={r.name}>
                <div>
                  <TextField
                    ariaLabel={`${r.name} URL`}
                    wide
                    value={remoteValues[r.name] ?? ""}
                    onChange={(v) => setRemoteValues((prev) => ({ ...prev, [r.name]: v }))}
                    onBlur={() => void commitRemote(r.name)}
                  />
                  {r.push_url && (
                    <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                      Pushes go to <span className="font-mono">{r.push_url}</span> — a separate push
                      URL, not edited here.
                    </p>
                  )}
                </div>
              </Field>
            ))
          )}

          <Divider />
          <PanelTitle>Branch upstream</PanelTitle>
          {overview.branches.length === 0 ? (
            <p className="text-xs text-[var(--color-muted-foreground)]">No local branches.</p>
          ) : (
            <>
              <Field label="Branch">
                <Select
                  ariaLabel="Branch"
                  value={branch}
                  onChange={setBranch}
                  options={overview.branches.map((b) => ({
                    value: b.name,
                    label: b.is_head ? `${b.name} (current)` : b.name,
                  }))}
                />
              </Field>
              <Field label="Upstream">
                <Select
                  ariaLabel="Upstream"
                  value={currentUpstream}
                  onChange={(v) => void onUpstreamChange(v)}
                  options={[
                    { value: NO_UPSTREAM, label: "None" },
                    ...overview.remote_branches.map((rb) => ({ value: rb, label: rb })),
                  ]}
                />
              </Field>
            </>
          )}

          <Divider />
          <PanelTitle>Branches</PanelTitle>
          {overview.branches.length === 0 ? (
            <p className="text-xs text-[var(--color-muted-foreground)]">No local branches.</p>
          ) : (
            <table className="mb-3 w-full text-xs" aria-label="Branches">
              <thead className="text-[var(--color-muted-foreground)]">
                <tr className="text-left">
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Branch
                  </th>
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Upstream
                  </th>
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Ahead/behind
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.branches.map((b) => (
                  <tr key={b.name} className="border-t">
                    <td className="py-1 pr-4 font-mono">
                      {b.name}
                      {b.is_head && (
                        <span className="ml-1 rounded bg-[var(--color-secondary)] px-1 text-[10px] text-[var(--color-secondary-foreground)]">
                          current
                        </span>
                      )}
                    </td>
                    <td className="py-1 pr-4 font-mono">
                      {upstreamShorthand(b.remote, b.merge) ?? "none"}
                    </td>
                    <td className="py-1 pr-4 font-mono">
                      {b.ahead == null && b.behind == null
                        ? "—"
                        : `+${b.ahead ?? 0} / -${b.behind ?? 0}`}
                    </td>
                    <td className="py-1">
                      {renamingBranch === b.name ? (
                        <div className="flex items-center gap-1">
                          <TextField
                            ariaLabel={`Rename ${b.name}`}
                            value={renameValue}
                            onChange={setRenameValue}
                          />
                          <Button
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => void submitRename()}
                          >
                            Save
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={cancelRename}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          {!b.is_head && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              aria-label={`Switch to branch ${b.name}`}
                              onClick={() => void switchBranch(b.name)}
                            >
                              Switch
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            aria-label={`Rename branch ${b.name}`}
                            onClick={() => startRename(b.name)}
                          >
                            Rename
                          </Button>
                          {!b.is_head && !b.protected && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-xs text-[var(--color-destructive)]"
                              aria-label={`Delete branch ${b.name}`}
                              onClick={() =>
                                setDeleteBranchTarget({ name: b.name, merged: b.merged })
                              }
                            >
                              Delete
                            </Button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submitNewBranch();
            }}
          >
            <Field label="New branch…">
              <TextField
                ariaLabel="New branch name"
                placeholder="branch-name"
                value={newBranchName}
                onChange={setNewBranchName}
              />
            </Field>
            <Field label="Base">
              <Select
                ariaLabel="Base branch"
                value={newBranchBase}
                onChange={setNewBranchBase}
                options={overview.branches.map((b) => ({ value: b.name, label: b.name }))}
              />
            </Field>
            <div className="flex items-center gap-2 pb-3">
              <Toggle checked={newBranchSwitch} onChange={setNewBranchSwitch} />
              <span className="text-xs text-[var(--color-muted-foreground)]">Switch to it</span>
            </div>
            <Button type="submit" size="sm" className="mb-3 h-8" disabled={!newBranchName.trim()}>
              <GitBranchPlus className="size-3.5" />
              Create branch
            </Button>
          </form>

          <Divider />
          <PanelTitle>Worktrees</PanelTitle>
          {worktrees.length === 0 ? (
            <p className="mb-2 text-xs text-[var(--color-muted-foreground)]">
              No linked worktrees.
            </p>
          ) : (
            <table className="mb-3 w-full text-xs" aria-label="Worktrees">
              <thead className="text-[var(--color-muted-foreground)]">
                <tr className="text-left">
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Path
                  </th>
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Branch
                  </th>
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Status
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {worktrees.map((w) => {
                  return (
                    <tr key={w.path} className="border-t">
                      <td className="max-w-56 truncate py-1 pr-4 font-mono" title={w.path}>
                        {w.path}
                      </td>
                      <td className="py-1 pr-4 font-mono">{w.branch ?? "(detached)"}</td>
                      <td className="py-1 pr-4">
                        <div className="flex gap-1">
                          {w.missing && (
                            <span className="rounded bg-[var(--color-destructive)]/10 px-1 text-[10px] text-[var(--color-destructive)]">
                              missing
                            </span>
                          )}
                          {w.locked && (
                            <span className="rounded bg-[var(--color-secondary)] px-1 text-[10px] text-[var(--color-secondary-foreground)]">
                              locked
                            </span>
                          )}
                          {w.prunable && (
                            <span className="rounded bg-[var(--color-secondary)] px-1 text-[10px] text-[var(--color-secondary-foreground)]">
                              prunable
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-1">
                        <div className="flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs text-[var(--color-destructive)]"
                            aria-label={`Remove worktree ${w.path}`}
                            onClick={() =>
                              setRemoveWorktreeTarget({
                                path: w.path,
                                escalated: false,
                                locked: w.locked,
                              })
                            }
                          >
                            Remove
                          </Button>
                          {!w.registered && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              aria-label={`Add worktree ${w.path} to sidebar`}
                              disabled={registerRepo.isPending}
                              onClick={() => void registerWorktree(w.path)}
                            >
                              Add to sidebar
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submitAddWorktree();
            }}
          >
            <Field label="Add worktree…">
              <div className="flex items-center gap-2">
                <TextField
                  ariaLabel="Worktree path"
                  wide
                  value={addWtPathValue}
                  onChange={(v) => {
                    setAddWtPath(v);
                    setAddWtPathTouched(true);
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={() => void chooseWorktreeFolder()}
                >
                  <FolderOpen className="size-3.5" />
                  Browse…
                </Button>
              </div>
            </Field>
            <Field label="Branch">
              <Segmented
                value={addWtMode}
                onChange={setAddWtMode}
                options={[
                  { value: "existing", label: "Existing" },
                  { value: "new", label: "New" },
                ]}
              />
            </Field>
            {addWtMode === "existing" ? (
              <div className="shrink-0 py-3">
                <Select
                  ariaLabel="Worktree branch"
                  value={addWtBranch}
                  onChange={setAddWtBranch}
                  options={overview.branches.map((b) => ({ value: b.name, label: b.name }))}
                />
              </div>
            ) : (
              <div className="shrink-0 py-3">
                <TextField
                  ariaLabel="New worktree branch name"
                  placeholder="branch-name"
                  value={addWtNewBranchName}
                  onChange={setAddWtNewBranchName}
                />
              </div>
            )}
            <Button
              type="submit"
              size="sm"
              className="mb-3 h-8"
              disabled={
                !addWtPathValue.trim() ||
                !(addWtMode === "existing" ? addWtBranch : addWtNewBranchName).trim()
              }
            >
              <GitBranchPlus className="size-3.5" />
              Add worktree
            </Button>
          </form>
          <Button variant="outline" size="sm" className="h-8" onClick={() => void pruneWorktrees()}>
            <Sparkles className="size-3.5" />
            Prune
          </Button>

          <Divider />
          <PanelTitle>Effective config</PanelTitle>
          {/* Scrolls sideways rather than wrapping: config values are routinely
              wider than the dialog (fetch refspecs, remote URLs, credential
              helper commands), and wrapping them turns single entries into
              multi-line rows that bury the rest of the table. `tabIndex`/`role`
              make the scroll region reachable without a pointer — a keyboard
              user otherwise cannot reach the clipped columns. */}
          <div
            tabIndex={0}
            className="overflow-x-auto focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none"
          >
            <table className="w-max min-w-full text-xs" aria-label="Effective git config entries">
              <thead className="text-[var(--color-muted-foreground)]">
                <tr className="text-left">
                  <th scope="col" className="py-1 pr-6 font-medium">
                    Key
                  </th>
                  <th scope="col" className="py-1 pr-6 font-medium">
                    Value
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Source
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.entries.map((entry, i) => (
                  <tr
                    key={`${entry.name}-${entry.level}-${i}`}
                    className={cn("border-t", !entry.effective && "opacity-60")}
                  >
                    <td className="py-1 pr-6 font-mono whitespace-nowrap">{entry.name}</td>
                    <td className="py-1 pr-6 font-mono whitespace-nowrap">
                      {entry.value == null ? <em>(non-UTF-8 value)</em> : entry.value}
                    </td>
                    <td className="py-1 whitespace-nowrap">
                      {entry.level}
                      {entry.effective && (
                        <span className="ml-1 rounded bg-[var(--color-secondary)] px-1 text-[10px] text-[var(--color-secondary-foreground)]">
                          current
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <ConfirmDeleteBranchDialog
        branchName={deleteBranchTarget?.name ?? null}
        merged={deleteBranchTarget?.merged ?? true}
        open={deleteBranchTarget != null}
        onOpenChange={(next) => {
          if (!next) setDeleteBranchTarget(null);
        }}
        onConfirm={(force) => void confirmDeleteBranch(force)}
      />
      <ConfirmRemoveWorktreeDialog
        path={removeWorktreeTarget?.path ?? null}
        escalated={removeWorktreeTarget?.escalated ?? false}
        open={removeWorktreeTarget != null}
        onOpenChange={(next) => {
          if (!next) setRemoveWorktreeTarget(null);
        }}
        onConfirm={(force) => confirmRemoveWorktree(force)}
      />
    </div>
  );
}
