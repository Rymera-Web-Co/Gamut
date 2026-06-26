import type { Group, Repo } from "@/lib/ipc";

/**
 * The single source of truth for which repos a group "contains" in the UI.
 * The default group owns every ungrouped repo (no explicit group), while any
 * other group owns the repos explicitly assigned to it. Kept here so the repo
 * sidebar, command palette, terminal, and the active-repo reconciler all agree
 * — drift between these would let the content area show a repo the sidebar
 * doesn't list.
 */
export function repoInGroup(repo: Repo, group: Group | undefined): boolean {
  if (!group) return false;
  return group.is_default ? repo.group_ids.length === 0 : repo.group_ids.includes(group.id);
}

/** The repos shown for a group, in their original order. */
export function visibleRepos(repos: Repo[], group: Group | undefined): Repo[] {
  return repos.filter((r) => repoInGroup(r, group));
}

/**
 * A repo's directory relative to its synced group's folder, using "/"
 * separators — e.g. group folder `/work`, repo `/work/foo/bar` → `"foo/bar"`.
 * Returns `null` when the group isn't folder-bound (`folderPath` null) or the
 * repo doesn't actually live under the folder, so callers can hide the
 * group-relative option instead of emitting a broken `../..`-style path.
 * Returns `""` when the repo *is* the group folder root.
 */
export function repoPathRelativeToGroupFolder(
  repoPath: string,
  folderPath: string | null,
): string | null {
  if (!folderPath) return null;
  // Normalise both to "/" separators with no trailing slash so the prefix
  // check is robust to mixed separators (Windows) and trailing slashes.
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(folderPath);
  const repo = norm(repoPath);
  if (repo === base) return "";
  if (repo.startsWith(`${base}/`)) return repo.slice(base.length + 1);
  return null;
}
