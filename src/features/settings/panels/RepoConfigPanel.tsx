import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ipc, type ConfigOverview, type IdentityFieldName, type IdentityValue } from "@/lib/ipc";
import { useActiveRepoIsGit } from "@/lib/useActiveRepo";
import { useUiStore } from "@/store/ui";
import { toast } from "@/store/toast";
import { Divider, Field, PanelTitle, Select, TextField } from "../controls";

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

export function RepoConfigPanel() {
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  const isGit = useActiveRepoIsGit();

  const [overview, setOverview] = useState<ConfigOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [emailValue, setEmailValue] = useState("");
  const [remoteValues, setRemoteValues] = useState<Record<string, string>>({});
  const [branch, setBranch] = useState("");

  // Bumped on every `refresh()` call; a response is applied only if it's still
  // the most recent one when it lands. Without this, a slow response for a
  // previous repo (or an earlier overlapping Refresh click) can resolve after
  // a newer one and overwrite the current repo's state with stale data — a
  // subsequent blur would then write the stale remote's URL into the
  // *current* repo's `.git/config`.
  const generationRef = useRef(0);

  // Re-read from disk and reset every unsaved draft to what's actually stored
  // — used for the mount load, the Refresh button (A8), after every
  // successful write (A24), and whenever the active repo changes (A10, via
  // the effect below), so a previous repo's unsaved edit never carries over.
  //
  // Exception: a field the user is actively typing into (has DOM focus) right
  // now is left alone. `refresh()` runs after every write, so committing Name
  // must not blow away whatever's mid-edit in Email — comparing against
  // `document.activeElement` at response time is simpler to reason about than
  // trying to track "written vs. untouched" per field.
  const refresh = useCallback(() => {
    if (activeRepoId == null) return;
    const generation = (generationRef.current += 1);
    setLoading(true);
    ipc
      .gitConfigOverview(activeRepoId)
      .then((ov) => {
        if (generationRef.current !== generation) return;
        setOverview(ov);

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
      })
      .catch(() => {
        if (generationRef.current !== generation) return;
        toast.error("Could not load git config");
      })
      .finally(() => {
        if (generationRef.current !== generation) return;
        setLoading(false);
      });
  }, [activeRepoId]);

  useEffect(() => {
    if (activeRepoId == null || !isGit) {
      setOverview(null);
      return;
    }
    refresh();
    // Only re-run on repo/git-ness changes, not on every `refresh` identity
    // change (it already depends on `activeRepoId`, which is in this list).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRepoId, isGit]);

  if (activeRepoId == null || !isGit) {
    return (
      <div>
        <PanelTitle>Repo config</PanelTitle>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Select a git repository to view and edit its config.
        </p>
      </div>
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
      await ipc.gitConfigSetIdentity(activeRepoId, "name", trimmed === "" ? null : trimmed);
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
      await ipc.gitConfigSetIdentity(activeRepoId, "email", trimmed === "" ? null : trimmed);
      refresh();
    } catch (e) {
      toast.error(String(e));
      setEmailValue(overview?.identity.email.value ?? "");
    }
  };

  const clearIdentity = async (field: IdentityFieldName) => {
    try {
      await ipc.gitConfigSetIdentity(activeRepoId, field, null);
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
      await ipc.gitConfigSetRemoteUrl(activeRepoId, name, trimmed);
      refresh();
    } catch (e) {
      toast.error(String(e));
      const reverted = overview?.remotes.find((r) => r.name === name)?.url ?? "";
      setRemoteValues((prev) => ({ ...prev, [name]: reverted }));
    }
  };

  const onUpstreamChange = async (value: string) => {
    try {
      await ipc.gitConfigSetBranchUpstream(
        activeRepoId,
        branch,
        value === NO_UPSTREAM ? null : value,
      );
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

  return (
    <div>
      <PanelTitle>Repo config</PanelTitle>
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
          <PanelTitle>Effective config</PanelTitle>
          <table className="w-full text-xs" aria-label="Effective git config entries">
            <thead className="text-[var(--color-muted-foreground)]">
              <tr className="text-left">
                <th scope="col" className="py-1 font-medium">
                  Key
                </th>
                <th scope="col" className="py-1 font-medium">
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
                  <td className="py-1 font-mono">{entry.name}</td>
                  <td className="py-1 font-mono">
                    {entry.value == null ? <em>(non-UTF-8 value)</em> : entry.value}
                  </td>
                  <td className="py-1">
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
        </>
      )}
    </div>
  );
}
