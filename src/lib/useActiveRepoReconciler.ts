import { useEffect } from "react";

import { useGroups, useRepos } from "@/features/repos/api";
import { visibleRepos } from "@/lib/groupRepos";
import { useUiStore } from "@/store/ui";

/**
 * Keep `activeRepoId` consistent with the active group. The content area renders
 * purely from `activeRepoId`, so a repo that isn't in the active group must not
 * stay selected — otherwise the right pane shows a repo the sidebar no longer
 * lists. Whenever the active group changes (or repos get reassigned/removed),
 * drop an out-of-group repo and fall back to the group's first visible repo, or
 * to nothing when the group is empty.
 *
 * This pairs with the per-group memory in `setActiveGroup`: that restores a
 * remembered repo optimistically, and this validates it against the group's
 * real membership. Mounted once at the app root so it runs even while the repo
 * sidebar is collapsed.
 */
export function useActiveRepoReconciler() {
  const repos = useRepos();
  const groups = useGroups();
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  const setActiveRepo = useUiStore((s) => s.setActiveRepo);

  const allRepos = repos.data;
  const allGroups = groups.data;

  useEffect(() => {
    if (!allRepos || !allGroups) return; // wait for the tree before reconciling
    const activeGroup = allGroups.find((g) => g.id === activeGroupId);
    const visible = visibleRepos(allRepos, activeGroup);
    if (activeRepoId != null && visible.some((r) => r.id === activeRepoId)) return;
    const next = visible[0]?.id ?? null;
    if (next !== activeRepoId) setActiveRepo(next);
  }, [allRepos, allGroups, activeGroupId, activeRepoId, setActiveRepo]);
}
