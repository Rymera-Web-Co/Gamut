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
 * The terminal view group is repaired the same way (#339). It moves
 * independently of the active group, so deleting the group it points at would
 * otherwise leave the terminal pane showing nothing at all.
 */
export function useActiveGroupFallback() {
  const groupsData = useGroups().data;
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const terminalViewGroupId = useUiStore((s) => s.terminalViewGroupId);
  const setActiveGroup = useUiStore((s) => s.setActiveGroup);
  const setTerminalViewGroup = useUiStore((s) => s.setTerminalViewGroup);

  useEffect(() => {
    if (!groupsData || groupsData.length === 0) return;
    if (!groupsData.some((g) => g.id === activeGroupId)) {
      const fallback = groupsData.find((g) => g.is_default) ?? groupsData[0];
      // setActiveGroup drags the terminal view along, so this repairs both.
      setActiveGroup(fallback?.id ?? null);
      return;
    }
    // The active group is fine but the terminal view points at a group that is
    // gone — send the pane back to the active group.
    // (It cannot already equal `activeGroupId` here: that id is in `groupsData`
    // and this one is not.)
    if (terminalViewGroupId != null && !groupsData.some((g) => g.id === terminalViewGroupId)) {
      setTerminalViewGroup(activeGroupId);
    }
  }, [groupsData, activeGroupId, terminalViewGroupId, setActiveGroup, setTerminalViewGroup]);
}
