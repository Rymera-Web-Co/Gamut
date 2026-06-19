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
