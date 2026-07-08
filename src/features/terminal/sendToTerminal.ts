import { toast } from "@/store/toast";
import { useUiStore } from "@/store/ui";
import { setPendingCommand } from "./pendingCommands";

/**
 * Wrap a token in double quotes when it contains whitespace, so it survives as a
 * single shell argument once typed into the terminal. Paths without spaces are
 * left bare to keep the common case clean. This is the minimal quoting the rest
 * of the terminal relies on (#199); it is deliberately not a full shell escaper.
 */
export function shellQuotePath(token: string): string {
  return /\s/.test(token) ? `"${token}"` : token;
}

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
  return shellQuotePath(ref);
}

/**
 * Format a list of file paths dropped from the OS file manager as one run of
 * terminal input: each path shell-quoted (so spaces survive as a single
 * argument) and space-separated. No trailing carriage return, so the caller
 * stages it as editable text rather than auto-executing it (#232, matching the
 * insert-don't-run behaviour of #199).
 */
export function filePathsForShell(paths: string[]): string {
  return paths.map(shellQuotePath).join(" ");
}

/**
 * Whether a paste's clipboard carries file references rather than plain text.
 * Copying a file in the OS file manager puts a file *reference* on the
 * clipboard; the webview signals its presence — a `File` entry, a `file`-kind
 * item, or a "Files" type — but hides the real path. This only gates whether a
 * terminal paste falls back to a native path read (#233): plain-text pastes
 * report none of these and are left to xterm's normal (bracketed) paste. The
 * three checks are OR'd because which one a given webview populates varies by
 * platform.
 */
export function clipboardHasFiles(dt: DataTransfer): boolean {
  if (dt.files.length > 0) return true;
  if (dt.types.includes("Files")) return true;
  return Array.from(dt.items).some((item) => item.kind === "file");
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
