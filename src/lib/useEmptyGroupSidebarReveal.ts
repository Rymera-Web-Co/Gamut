import { useEffect, useRef } from "react";

import { useGroups, useRepos } from "@/features/repos/api";
import { visibleRepos } from "@/lib/groupRepos";
import { useUiStore } from "@/store/ui";

/**
 * Auto-open the repo sidebar when the user switches to a group that has no
 * repositories, so they land on the (empty) sidebar ready to add one instead of
 * a hidden panel with no obvious next step (#283).
 *
 * The switch-detection lives here rather than in `setActiveGroup` because that
 * store action has no access to the repo list; this mirrors
 * `useActiveRepoReconciler`, reading the react-query repo/group data and the
 * active group id, and is mounted once at the app root.
 *
 * Deliberately narrow, to avoid fighting the user:
 * - fires only on a genuine group→group switch (tracked via `prevGroupId`), not
 *   on repo-data refetches or unrelated re-renders;
 * - skips the initial null→first-group mount transition, so a returning user who
 *   saved "hidden" isn't forced open on launch;
 * - reveals transiently: the sidebar stays open for the rest of the session,
 *   but the persisted hidden/shown preference is never written, so the user's
 *   saved default is honoured again on the next launch.
 */
export function useEmptyGroupSidebarReveal() {
  const repos = useRepos();
  const groups = useGroups();
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const revealRepoSidebar = useUiStore((s) => s.revealRepoSidebar);

  const allRepos = repos.data;
  const allGroups = groups.data;

  // The group id at the previous evaluation, so we only act on real switches.
  const prevGroupId = useRef(activeGroupId);

  useEffect(() => {
    const prev = prevGroupId.current;
    if (activeGroupId === prev) return; // same group (e.g. a data refetch) → nothing to do
    if (!allRepos || !allGroups) return; // wait for the tree; re-runs once it loads
    prevGroupId.current = activeGroupId;
    // Skip the boot transition into the first group and any "no group" state.
    if (prev == null || activeGroupId == null) return;
    const group = allGroups.find((g) => g.id === activeGroupId);
    const isEmpty = visibleRepos(allRepos, group).length === 0;
    if (isEmpty && useUiStore.getState().repoSidebarHidden) revealRepoSidebar();
  }, [allRepos, allGroups, activeGroupId, revealRepoSidebar]);
}
