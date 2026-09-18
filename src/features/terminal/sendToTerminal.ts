import { toast } from "@/store/toast";
import { useUiStore } from "@/store/ui";
import { setPendingCommand } from "./pendingCommands";

/**
 * Quote a path so it survives as a single, literal shell argument once typed
 * into the terminal.
 *
 * A path made up entirely of characters the shell never treats specially is
 * left bare, to keep the common case clean. Anything else is wrapped in POSIX
 * single quotes, inside which the shell takes every character literally — no
 * whitespace splitting, `$`/backtick expansion, globbing, or `!` history
 * expansion. An embedded single quote can't appear inside a single-quoted
 * string, so it's emitted with the standard `'\''` sequence: close the quote, a
 * backslash-escaped literal quote, reopen. This replaces the earlier
 * double-quote wrapper, which still let `$`, backticks and `\` through and so
 * could turn a dropped filename like `$(cmd)` into a live command (#232).
 *
 * `#` is allowed unquoted only when it isn't the first character: a leading `#`
 * starts a comment, but `#` mid-word (e.g. the `path#L12` line anchor from
 * #199) is literal, so those references stay clean.
 */
export function shellQuotePath(token: string): string {
  if (/^[A-Za-z0-9_./@%+=:,-][A-Za-z0-9_./@%+=:,#-]*$/.test(token)) return token;
  return `'${token.replace(/'/g, "'\\''")}'`;
}

/**
 * Build a GitHub-style location reference for a file (and optional line range),
 * matching the `path#Lstart-Lend` anchor format GitHub uses for permalinks:
 *
 * - no lines            → `src/foo.ts`
 * - single line/caret   → `src/foo.ts#L12`
 * - multi-line range     → `src/foo.ts#L12-L20`
 *
 * The whole token is shell-quoted when the path isn't a bare safe word, so it
 * survives as a single literal argument once it lands in the terminal.
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
 * Insert `text` into the active terminal as editable input — no trailing
 * carriage return, so it stages at the cursor and can be wrapped in a command
 * before the user hits Enter (issue #199).
 *
 * Prefers a terminal belonging to the active group — the text is usually a path
 * from the repo the user is browsing, and the terminal list spans every group
 * now, so targeting the globally-active tab could stage that path in a shell
 * rooted in a different repo. Falls back to the globally-active tab when the
 * active group has no terminal; if none is open at all, one is opened in the
 * active group first. The text is queued via the pending-command store and the
 * pane is revealed: the session manager drains the queue whether the PTY is
 * already live or spawns on reveal, so there's never a double write.
 */
export function sendToActiveTerminal(text: string): void {
  const ui = useUiStore.getState();
  const { tabs, activeTabId } = ui.terminals;
  const inGroup = tabs.filter((t) => t.groupId === ui.activeGroupId);
  const tab =
    inGroup.find((t) => t.id === activeTabId) ??
    inGroup[0] ??
    tabs.find((t) => t.id === activeTabId) ??
    tabs[0];

  let tabId: string;
  let paneId: string;
  if (tab) {
    tabId = tab.id;
    paneId = tab.activePaneId;
  } else {
    // No terminal open yet — open one (rooted at the active group's default) so
    // the action always has somewhere to land.
    const groupId = ui.activeGroupId;
    if (groupId == null) {
      toast.error("Open a group to send to its terminal");
      return;
    }
    paneId = ui.addTerminalTab(groupId, "", "terminal");
    const openedTab = useUiStore.getState().terminals.tabs.find((t) => t.activePaneId === paneId);
    if (!openedTab) return;
    tabId = openedTab.id;
  }

  setPendingCommand(paneId, text);
  ui.focusTerminal(tabId, paneId);
}
