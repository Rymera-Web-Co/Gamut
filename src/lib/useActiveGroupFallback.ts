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
 *
 * Terminals whose group was deleted are re-homed onto the same fallback group.
 * The terminal list is global, so a deleted group no longer takes its terminals
 * off screen with it: the tab would otherwise keep a live shell and stay
 * reachable by the cycle chords while naming no group and offering no way back.
 */
export function useActiveGroupFallback() {
  const groupsData = useGroups().data;
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const setActiveGroup = useUiStore((s) => s.setActiveGroup);
  const reparentOrphanTerminals = useUiStore((s) => s.reparentOrphanTerminals);

  useEffect(() => {
    if (!groupsData || groupsData.length === 0) return;
    const fallback = groupsData.find((g) => g.is_default) ?? groupsData[0];
    if (fallback) {
      reparentOrphanTerminals(
        groupsData.map((g) => g.id),
        fallback.id,
      );
    }
    if (groupsData.some((g) => g.id === activeGroupId)) return;
    setActiveGroup(fallback?.id ?? null);
  }, [groupsData, activeGroupId, setActiveGroup, reparentOrphanTerminals]);
}
