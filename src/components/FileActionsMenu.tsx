import { Columns2, Link as LinkIcon, TerminalSquare } from "lucide-react";

import {
  ContextMenu,
  ContextMenuItem,
  type ContextMenuPosition,
} from "@/components/ui/context-menu";
import { fileReference, sendToActiveTerminal } from "@/features/terminal/sendToTerminal";
import { copy } from "@/lib/clipboard";
import { ipc } from "@/lib/ipc";
import { useGroupRelativePrefix } from "@/lib/useGroupRelativePrefix";
import { toast } from "@/store/toast";
import { useUiStore } from "@/store/ui";

/** A right-clicked file plus where to anchor the menu. */
export interface FileMenuTarget {
  /** Repo-relative path. */
  path: string;
  pos: ContextMenuPosition;
}

/**
 * The portable per-file actions from the Files-tab tree context menu (copy
 * paths, send to terminal, compare), reused wherever a file is listed. Render it
 * once and drive it with a target captured from an `onContextMenu` handler.
 * Excludes tree-only actions (New File/Folder, Rename, Delete) that need the
 * tree's inline-edit UI and mutation wiring.
 */
export function FileActionsMenu({
  repoId,
  target,
  onClose,
}: {
  repoId: number;
  target: FileMenuTarget | null;
  onClose: () => void;
}) {
  const compareSelection = useUiStore((s) => s.compareSelection);
  const setCompareSelection = useUiStore((s) => s.setCompareSelection);
  const openCompare = useUiStore((s) => s.openCompare);
  const groupRelativePrefix = useGroupRelativePrefix(repoId);

  const path = target?.path ?? "";

  // Diff the previously "Select for Compare" file against this one. Both are
  // resolved to absolute paths (they may be in different repos) and fed to the
  // two-files compare flow.
  async function compareWithSelected() {
    if (!compareSelection) return;
    onClose();
    try {
      const [leftPath, rightPath] = await Promise.all([
        ipc.resolvePath(compareSelection.repoId, compareSelection.path),
        ipc.resolvePath(repoId, path),
      ]);
      openCompare({ files: { leftPath, rightPath } });
    } catch (e) {
      toast.error(String(e));
    }
  }

  return (
    <ContextMenu at={target?.pos ?? null} onClose={onClose}>
      {target && (
        <>
          <ContextMenuItem
            className="text-xs"
            onClick={() => {
              onClose();
              ipc
                .resolvePath(repoId, path)
                .then((abs) => copy(abs, "Copied path"))
                .catch((e) => toast.error(String(e)));
            }}
          >
            <LinkIcon />
            Copy Path
          </ContextMenuItem>
          <ContextMenuItem
            className="text-xs"
            onClick={() => {
              void copy(path, "Copied relative path");
              onClose();
            }}
          >
            <LinkIcon />
            Copy Relative Path
          </ContextMenuItem>
          {groupRelativePrefix != null && (
            <ContextMenuItem
              className="text-xs"
              onClick={() => {
                const rel = groupRelativePrefix ? `${groupRelativePrefix}/${path}` : path;
                void copy(rel, "Copied group-relative path");
                onClose();
              }}
            >
              <LinkIcon />
              Copy Path (relative to group)
            </ContextMenuItem>
          )}
          <div className="my-1 border-t border-[var(--color-border)]" />
          <ContextMenuItem
            className="text-xs"
            onClick={() => {
              // The reference is the repo-relative path only — no line range (#199).
              sendToActiveTerminal(fileReference(path));
              onClose();
            }}
          >
            <TerminalSquare />
            Send to Terminal
          </ContextMenuItem>
          <div className="my-1 border-t border-[var(--color-border)]" />
          <ContextMenuItem
            className="text-xs"
            onClick={() => {
              setCompareSelection({ repoId, path });
              onClose();
            }}
          >
            <Columns2 />
            Select for Compare
          </ContextMenuItem>
          {compareSelection &&
            !(compareSelection.repoId === repoId && compareSelection.path === path) && (
              <ContextMenuItem className="text-xs" onClick={() => void compareWithSelected()}>
                <Columns2 />
                Compare with Selected
              </ContextMenuItem>
            )}
        </>
      )}
    </ContextMenu>
  );
}
