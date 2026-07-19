import { useEffect, useRef, type RefObject } from "react";
import type { OnMount } from "@monaco-editor/react";

import { ipc, type IdeSelection } from "@/lib/ipc";

type CodeEditor = Parameters<OnMount>[0];
type MonacoSelection = NonNullable<ReturnType<CodeEditor["getSelection"]>>;

/** Debounce window for pushing selection changes — long enough to coalesce a
 * drag / rapid caret moves into one push, short enough to feel live. */
const DEBOUNCE_MS = 150;

/**
 * Convert a Monaco selection into the IDE protocol's payload. Monaco uses
 * 1-based line numbers and 1-based UTF-16 columns; the protocol wants zero-based
 * line/character, so each coordinate drops by one. Exported for testing.
 */
export function toIdeSelection(
  sel: Pick<MonacoSelection, "startLineNumber" | "startColumn" | "endLineNumber" | "endColumn"> & {
    isEmpty(): boolean;
  },
  filePath: string,
  text: string,
): IdeSelection {
  return {
    text,
    file_path: filePath,
    start_line: sel.startLineNumber - 1,
    start_char: sel.startColumn - 1,
    end_line: sel.endLineNumber - 1,
    end_char: sel.endColumn - 1,
    is_empty: sel.isEmpty(),
  };
}

/**
 * Mirror the open file's Monaco selection to the Claude Code IDE integration, so
 * any `claude` running in an integrated terminal picks it up as ambient context
 * (the same behaviour as the VS Code / Neovim integrations).
 *
 * Wired once the editor is ready; reads the live repo/path through refs so the
 * single `onDidChangeCursorSelection` listener always reports the file that's
 * currently loaded. The selection is converted from Monaco's 1-based
 * line/column (UTF-16) to the protocol's zero-based LSP coordinates, and the
 * repo-relative path is resolved to an absolute one (cached per file). Pushes
 * are debounced. The backend no-ops when no `claude` is connected, so this stays
 * cheap when the integration is idle.
 */
export function useIdeSelectionSync(
  editorRef: RefObject<CodeEditor | null>,
  editorReady: boolean,
  repoId: number | null,
  selectedPath: string | null,
) {
  // The open file's path, mirrored in a ref so the async path-resolve below can
  // discard a result that lands after the user has switched files.
  const pathRef = useRef(selectedPath);
  pathRef.current = selectedPath;

  // Absolute path of the open file, resolved when the file changes so the
  // per-selection push doesn't await an IPC round-trip each time. Null until
  // resolved (or when nothing is open).
  const absPathRef = useRef<string | null>(null);
  useEffect(() => {
    absPathRef.current = null;
    if (repoId == null || selectedPath == null) return;
    let cancelled = false;
    ipc
      .resolvePath(repoId, selectedPath)
      .then((abs) => {
        // Ignore a stale resolve that lands after the user switched files.
        if (!cancelled && pathRef.current === selectedPath) absPathRef.current = abs;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoId, selectedPath]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editorReady || !editor) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const push = () => {
      const absPath = absPathRef.current;
      if (absPath == null) return; // path not resolved yet — skip this change
      const sel = editor.getSelection();
      if (!sel) return;
      const model = editor.getModel();
      const text = model ? model.getValueInRange(sel) : "";
      void ipc.ideSelectionChanged(toIdeSelection(sel, absPath, text)).catch(() => {});
    };

    const disposable = editor.onDidChangeCursorSelection(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(push, DEBOUNCE_MS);
    });

    return () => {
      if (timer) clearTimeout(timer);
      disposable.dispose();
    };
  }, [editorRef, editorReady]);
}
