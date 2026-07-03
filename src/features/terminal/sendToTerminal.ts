import { toast } from "@/store/toast";
import { useUiStore } from "@/store/ui";
import { setPendingCommand } from "./pendingCommands";

/**
 * Build a GitHub-style location reference for a file (and optional line range),
 * matching the `path#Lstart-Lend` anchor format GitHub uses for permalinks:
 *
 * - no lines            → `src/foo.ts`
 * - single line/caret   → `src/foo.ts#L12`
 * - multi-line range     → `src/foo.ts#L12-L20`
 *
 * The whole token is wrapped in double quotes when the path contains whitespace,
 * so it survives as a single shell argument once it lands in the terminal.
 */
export function fileReference(path: string, startLine?: number, endLine?: number): string {
  let ref = path;
  if (startLine != null) {
    ref += `#L${startLine}`;
    if (endLine != null && endLine > startLine) ref += `-L${endLine}`;
  }
  return /\s/.test(ref) ? `"${ref}"` : ref;
}

/**
 * Insert `text` into the active group's active terminal as editable input — no
 * trailing carriage return, so it stages at the cursor and can be wrapped in a
 * command before the user hits Enter (issue #199).
 *
 * Targets the active tab's active pane in the active group; if that group has no
 * terminal yet, one is opened first. The text is queued via the pending-command
 * store and the pane is revealed: the session manager drains the queue whether
 * the PTY is already live or spawns on reveal, so there's never a double write.
 */
export function sendToActiveTerminal(text: string): void {
  const ui = useUiStore.getState();
  const groupId = ui.activeGroupId;
  if (groupId == null) {
    toast.error("Open a group to send to its terminal");
    return;
  }

  const group = ui.terminals[groupId];
  const tab = group?.tabs.find((t) => t.id === group.activeTabId) ?? group?.tabs[0];

  let tabId: string;
  let paneId: string;
  if (tab) {
    tabId = tab.id;
    paneId = tab.activePaneId;
  } else {
    // No terminal in this group yet — open one (rooted at the group default) so
    // the action always has somewhere to land.
    paneId = ui.addTerminalTab(groupId, "", "terminal");
    const opened = useUiStore.getState().terminals[groupId];
    const openedTab = opened?.tabs.find((t) => t.activePaneId === paneId);
    if (!openedTab) return;
    tabId = openedTab.id;
  }

  setPendingCommand(paneId, text);
  ui.focusTerminal(groupId, tabId, paneId);
}
