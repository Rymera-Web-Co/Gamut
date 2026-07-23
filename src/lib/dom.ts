/**
 * Whether a modal dialog is currently open anywhere in the document. Radix
 * dialogs (Settings, File Compare, …) render their content with `role="dialog"`
 * and alert dialogs with `role="alertdialog"`, so this query covers both.
 *
 * Window-level keyboard handlers use this to stand down while a dialog owns the
 * interaction — e.g. the Files view's ⌘/Ctrl+S must not save the backgrounded
 * file while the Compare dialog is open (#276).
 */
export function isModalOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') != null;
}
