import { useEffect } from "react";

import { useGroups } from "@/features/repos/api";
import { useUiStore } from "@/store/ui";

/**
 * Keep `activeGroupId` pointing at a real group: on boot (null) or after the
 * active group is deleted, fall back to the default group (else the first).
 *
 * App-level on purpose — it used to live in the sidebar, but the sidebar is
 * conditionally mounted (⌘B hides it), so a hidden-sidebar boot would leave
 * `activeGroupId` null and every group-scoped surface (terminals, shortcuts,
 * CLI nav) pointing nowhere.
 */
export function useActiveGroupFallback() {
  const groupsData = useGroups().data;
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const setActiveGroup = useUiStore((s) => s.setActiveGroup);

  useEffect(() => {
    if (!groupsData || groupsData.length === 0) return;
    if (!groupsData.some((g) => g.id === activeGroupId)) {
      const fallback = groupsData.find((g) => g.is_default) ?? groupsData[0];
      setActiveGroup(fallback?.id ?? null);
    }
  }, [groupsData, activeGroupId, setActiveGroup]);
}
