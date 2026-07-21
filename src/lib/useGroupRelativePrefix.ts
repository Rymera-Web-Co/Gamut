import { useGroups, useRepos } from "@/features/repos/api";
import { repoPathRelativeToGroupFolder } from "@/lib/groupRepos";
import { useUiStore } from "@/store/ui";

/**
 * The active repo's path relative to its group folder, or null when the active
 * group isn't folder-bound or the repo doesn't live under it. Sibling repos in a
 * synced group share a `src/`, so a group-relative path uniquely identifies a
 * file across the whole folder (#173) — used to offer a "Copy Path (relative to
 * group)" action wherever a file is listed.
 */
export function useGroupRelativePrefix(repoId: number | null): string | null {
  const repos = useRepos();
  const groups = useGroups();
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const repo = repos.data?.find((r) => r.id === repoId);
  const activeGroup = groups.data?.find((g) => g.id === activeGroupId);
  return repo != null
    ? repoPathRelativeToGroupFolder(repo.path, activeGroup?.folder_path ?? null)
    : null;
}
