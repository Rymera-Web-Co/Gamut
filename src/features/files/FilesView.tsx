import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { OnMount } from "@monaco-editor/react";
import { FileDiff, FolderOpen, FolderTree, GitCompare, Loader2, Save, Search } from "lucide-react";

import { Markdown } from "@/components/Markdown";
// Lazy Monaco wrapper — aliased to `Editor` so the JSX below is unchanged (#141).
import { CodeEditor as Editor } from "@/components/MonacoEditor";
import { Button } from "@/components/ui/button";
import { WordWrapToggle } from "@/components/WordWrapToggle";
import { Panel, PanelGroup, ResizeHandle } from "@/components/ui/resizable";
import { ipc } from "@/lib/ipc";
import { isModalOpen } from "@/lib/dom";
import { isDarkTheme, languageFor } from "@/lib/lang";
import { GITHUB_DARK } from "@/lib/monacoTheme";
import { useEditorPrefs, useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast";
import { useUiStore } from "@/store/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useGroups, useRepos } from "@/features/repos/api";
import { repoPathRelativeToGroupFolder } from "@/lib/groupRepos";
import { isImagePath } from "@/lib/images";
import { fileReference, sendToActiveTerminal } from "@/features/terminal/sendToTerminal";
import { useFileContent, useWorktreeStatus } from "./api";
import { ImageView } from "./ImageView";
import { RepoTree, type TreeChanges } from "./RepoTree";
import { SearchPanel } from "./SearchPanel";
import { useIdeSelectionSync } from "./useIdeSelectionSync";

type CodeEditor = Parameters<OnMount>[0];

/** A pending "jump to this match", applied once its file is loaded into the
 * editor. Columns are 1-based UTF-16 (Monaco's coordinate space). */
interface RevealTarget {
  path: string;
  line: number;
  startCol: number;
  endCol: number;
}

// Remember the last-open file per repo so reopening a repo lands where you left.
const LAST_FILE_KEY = "gamut.filesLastOpen";

function readLastFiles(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LAST_FILE_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function lastFileFor(repoId: number): string | null {
  return readLastFiles()[String(repoId)] ?? null;
}
function rememberFile(repoId: number, path: string | null) {
  const map = readLastFiles();
  if (path) map[String(repoId)] = path;
  else delete map[String(repoId)];
  localStorage.setItem(LAST_FILE_KEY, JSON.stringify(map));
}

/** A sidebar mode switch (file tree vs. search) in the Files view left panel. */
function ModeButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex size-7 items-center justify-center rounded-md",
        active
          ? "bg-[var(--color-accent)] text-[var(--color-foreground)]"
          : "text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)]",
      )}
    >
      {children}
    </button>
  );
}

export function FilesView() {
  const repoId = useUiStore((s) => s.activeRepoId);
  const setView = useUiStore((s) => s.setView);
  const setReviewMode = useUiStore((s) => s.setReviewMode);
  const filesPath = useUiStore((s) => s.filesPath);
  const setFilesPath = useUiStore((s) => s.setFilesPath);
  const openCompare = useUiStore((s) => s.openCompare);
  const filesPanel = useUiStore((s) => s.filesPanel);
  const setFilesPanel = useUiStore((s) => s.setFilesPanel);
  const repos = useRepos();
  const repo = repos.data?.find((r) => r.id === repoId);
  // For repos in a synced (folder-bound) group, offer a copy path that's
  // relative to the group folder rather than the repo root — sibling repos
  // share a `src/`, so a group-relative path uniquely identifies a file across
  // the whole folder (#173). Null when the active group isn't folder-bound or
  // the repo doesn't live under it, in which case the tree hides the option.
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const groups = useGroups();
  const activeGroup = groups.data?.find((g) => g.id === activeGroupId);
  const groupRelativePrefix =
    repo != null
      ? repoPathRelativeToGroupFolder(repo.path, activeGroup?.folder_path ?? null)
      : null;
  const editorPrefs = useEditorPrefs();
  const queryClient = useQueryClient();

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Mirror the open path in a ref so the editor's context-menu action (bound
  // once at mount) always reads the file that's currently loaded (#199).
  const selectedPathRef = useRef<string | null>(null);
  selectedPathRef.current = selectedPath;
  const [value, setValue] = useState("");
  const [baseline, setBaseline] = useState("");
  // Which file the editor buffer currently belongs to — guards against the
  // content query clobbering unsaved edits on refetch.
  const loadedRef = useRef<string | null>(null);
  // The live Monaco instance, plus a pending jump-to-match from a search result.
  const editorRef = useRef<CodeEditor | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  // The live Monaco instance as state (not just the ref) so consumers that must
  // re-run when the editor is remounted — e.g. the IDE selection sync — observe
  // the new instance instead of a stale ref.
  const [editor, setEditor] = useState<CodeEditor | null>(null);
  const [pendingReveal, setPendingReveal] = useState<RevealTarget | null>(null);

  // Mirror the open file's selection to any `claude` running in an integrated
  // terminal (Claude Code IDE integration), so highlighting lines here feeds
  // them in as ambient context.
  useIdeSelectionSync(editor, repoId, selectedPath);

  // Images get their own preview path (loaded as a data: URL), so skip the
  // text read for them — it would only report them as binary.
  const isImage = selectedPath != null && isImagePath(selectedPath);
  const content = useFileContent(repoId, isImage ? null : selectedPath);
  const editable = content.data?.text != null;
  const dirty = editable && value !== baseline;
  // Markdown files get a rendered-preview toggle (issue #121); `mdPreview` swaps
  // the editor between raw source and the rendered view. Its initial state per
  // file follows the "open markdown in preview" preference.
  const isMarkdown = selectedPath != null && !isImage && languageFor(selectedPath) === "markdown";
  const markdownPreviewByDefault = useSettings((s) => s.values.markdownPreviewByDefault);
  const [mdPreview, setMdPreview] = useState(markdownPreviewByDefault);

  // Whether Monaco (the right-pane render chain's final `else` branch, below)
  // is what's actually shown — gates the word-wrap toggle (#295), which only
  // makes sense while a Monaco editor is mounted. Mirrors that chain's clauses
  // exactly (file selected, not an image, not loading/errored, not
  // too_large/is_binary/encoding_error, not the markdown preview pane) so the
  // two can't silently drift; if a clause is added there, add it here too.
  const editorShown =
    selectedPath != null &&
    !isImage &&
    !content.isLoading &&
    !content.isError &&
    !content.data?.too_large &&
    !content.data?.is_binary &&
    !content.data?.encoding_error &&
    !(isMarkdown && mdPreview);

  // Map changed working-tree paths so the tree can highlight files (and the
  // directories that contain them).
  const status = useWorktreeStatus(repoId, repo?.is_git_repo ?? true);
  const changes = useMemo<TreeChanges>(() => {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    const all = [...(status.data?.staged ?? []), ...(status.data?.unstaged ?? [])];
    for (const f of all) {
      files.set(f.path, f.status);
      const parts = f.path.split("/");
      let acc = "";
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i];
        dirs.add(acc);
      }
    }
    return { files, dirs };
  }, [status.data]);

  // Reapply the preview default whenever the open file changes, so opening a
  // markdown file lands on the preferred view rather than a stale per-file
  // toggle. Re-runs if the preference itself changes while a file is open.
  useEffect(() => {
    setMdPreview(markdownPreviewByDefault);
  }, [selectedPath, markdownPreviewByDefault]);

  // Switching repos: drop the buffer and restore that repo's last-open file.
  useEffect(() => {
    loadedRef.current = null;
    setValue("");
    setBaseline("");
    setSelectedPath(repoId != null ? lastFileFor(repoId) : null);
  }, [repoId]);

  // Consume a deep-link from elsewhere (e.g. the Review tab's "Edit" button):
  // open the requested file, then clear the one-shot signal. Declared after the
  // repo effect so it wins when both fire on the same mount.
  useEffect(() => {
    if (filesPath == null) return;
    setFilesPath(null);
    if (repoId == null || filesPath === selectedPath) return;
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    loadedRef.current = null;
    setSelectedPath(filesPath);
    rememberFile(repoId, filesPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on filesPath
  }, [filesPath]);

  // Load the buffer when a file is selected, and adopt external on-disk changes
  // when there are no unsaved edits. A dirty buffer is never clobbered — the
  // user's edits win until they save or switch away. (text === null for
  // binary/oversized files.)
  useEffect(() => {
    if (selectedPath == null || !content.data) return;
    const text = content.data.text ?? "";
    if (loadedRef.current !== selectedPath) {
      setValue(text);
      setBaseline(text);
      loadedRef.current = selectedPath;
    } else if (!dirty && text !== baseline) {
      setValue(text);
      setBaseline(text);
    }
  }, [selectedPath, content.data, dirty, baseline]);

  const save = useCallback(async () => {
    if (repoId == null || selectedPath == null || !dirty) return;
    try {
      await ipc.writeFile(repoId, selectedPath, value);
      setBaseline(value);
      queryClient.invalidateQueries({ queryKey: ["file", repoId, selectedPath] });
      toast.success(`Saved ${selectedPath}`);
    } catch (e) {
      toast.error(String(e));
    }
  }, [repoId, selectedPath, value, dirty, queryClient]);

  // ⌘/Ctrl+S saves, whether or not the editor has focus.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        // Always claim the chord so it never falls through to the webview's
        // native "Save page as". But stand down while a modal dialog owns the
        // interaction — e.g. the Compare dialog handles ⌘S on its own editor;
        // saving the backgrounded file here would hijack it (#276).
        e.preventDefault();
        if (isModalOpen()) return;
        void save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // ⌘/Ctrl+F → Monaco find, ⌘/Ctrl+H → Monaco find+replace, in the open file —
  // works even when focus is in the tree/search panel. We skip plain text inputs
  // (the search/glob fields) so it doesn't hijack typing there; Monaco's own
  // editing surface is a <textarea>, which we still allow.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key !== "f" && key !== "h") return;
      if (e.shiftKey) return; // ⌘/Ctrl+⇧+F is repo-wide search (global shortcut)
      // Stand down while a modal dialog is open — e.g. the Compare dialog owns
      // find/replace on its own editor, so we must not steal focus back to the
      // backgrounded Files editor (#276, same modal-hijack shape as ⌘S above).
      if (isModalOpen()) return;
      const ed = editorRef.current;
      if (!editable || !ed) return;
      if (document.activeElement?.tagName === "INPUT") return;
      e.preventDefault();
      ed.focus();
      ed.getAction(key === "f" ? "actions.find" : "editor.action.startFindReplaceAction")?.run();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable]);

  // Apply a pending search-result jump once the editor exists and its buffer
  // holds the target file (loadedRef flips in the content-load effect above).
  useEffect(() => {
    const ed = editorRef.current;
    if (!pendingReveal || !ed || !editorReady) return;
    if (loadedRef.current !== pendingReveal.path) return;
    ed.revealLineInCenter(pendingReveal.line);
    ed.setSelection({
      startLineNumber: pendingReveal.line,
      startColumn: pendingReveal.startCol,
      endLineNumber: pendingReveal.line,
      endColumn: pendingReveal.endCol,
    });
    ed.focus();
    setPendingReveal(null);
    // Keyed on `content.data` (the load-completion signal that flips loadedRef in
    // the effect above), not the editor `value` — the buffer changes on every
    // keystroke and re-ran this effect needlessly (#142), while `content.data`
    // only changes when a file actually loads, which is what gates the reveal.
  }, [pendingReveal, editorReady, content.data]);

  // Open a search result: switch to its file (guarding unsaved edits) and queue
  // the jump-to-match for when the buffer loads.
  const openResult = useCallback(
    (path: string, line: number, startCol: number, endCol: number) => {
      if (repoId == null) return;
      if (path !== selectedPath) {
        if (dirty && !window.confirm("Discard unsaved changes?")) return;
        loadedRef.current = null;
        setSelectedPath(path);
        rememberFile(repoId, path);
      }
      setPendingReveal({ path, line, startCol, endCol });
    },
    [repoId, selectedPath, dirty],
  );

  // Warn before closing the app/window with unsaved edits.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function selectFile(path: string) {
    if (path === selectedPath) return;
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    loadedRef.current = null;
    setSelectedPath(path);
    if (repoId != null) rememberFile(repoId, path);
  }

  // A file/dir was deleted from the tree: if the open file lived there, drop
  // the buffer so the editor doesn't dangle on a gone path.
  function onTreeDeleted(path: string) {
    if (repoId == null || selectedPath == null) return;
    if (selectedPath === path || selectedPath.startsWith(`${path}/`)) {
      loadedRef.current = null;
      setSelectedPath(null);
      setValue("");
      setBaseline("");
      rememberFile(repoId, null);
    }
  }

  // A file/dir was renamed/moved in the tree: if the open file lived under it,
  // follow it to the new path. The bytes on disk are unchanged, so keep the
  // buffer (loadedRef → new path) rather than reloading and dropping edits.
  function onTreeRenamed(from: string, to: string) {
    if (repoId == null || selectedPath == null) return;
    let next: string | null = null;
    if (selectedPath === from) next = to;
    else if (selectedPath.startsWith(`${from}/`)) next = `${to}${selectedPath.slice(from.length)}`;
    if (next == null) return;
    loadedRef.current = next;
    setSelectedPath(next);
    rememberFile(repoId, next);
  }

  function viewChanges() {
    setReviewMode("working");
    setView("review");
  }

  async function reveal() {
    if (repoId == null) return;
    try {
      await ipc.revealInFileManager(repoId, selectedPath);
    } catch (e) {
      toast.error(String(e));
    }
  }

  if (repoId == null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <FolderTree className="size-8 text-[var(--color-muted-foreground)]" />
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Select a repository from the left to browse its files.
        </p>
      </div>
    );
  }

  const isDark = isDarkTheme();

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <h1 className="shrink-0 text-sm font-semibold">{repo?.name ?? "Files"}</h1>
        {selectedPath && (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-muted-foreground)]">
            {selectedPath}
            {dirty && <span className="ml-1 text-[var(--color-foreground)]">•</span>}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {isMarkdown && editable && (
            <div className="mr-1 flex items-center rounded-md border p-0.5">
              {(
                [
                  ["Edit", false],
                  ["Preview", true],
                ] as const
              ).map(([label, preview]) => (
                <button
                  key={label}
                  type="button"
                  aria-pressed={mdPreview === preview}
                  onClick={() => setMdPreview(preview)}
                  className={cn(
                    "rounded px-2 py-1 text-xs font-medium",
                    mdPreview === preview
                      ? "bg-[var(--color-accent)] text-[var(--color-foreground)]"
                      : "text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {editorShown && <WordWrapToggle />}
          {repo?.is_git_repo !== false && selectedPath && (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={() => openCompare({ repoId, path: selectedPath })}
              title="Compare this file across refs or against a revision"
            >
              <FileDiff className="size-4" />
              Compare
            </Button>
          )}
          {repo?.is_git_repo !== false && (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={viewChanges}
              title="Switch to Review (working tree)"
            >
              <GitCompare className="size-4" />
              View changes
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5"
            onClick={reveal}
            title="Reveal in the OS file manager (Finder / Explorer)"
          >
            <FolderOpen className="size-4" />
            Reveal
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="gap-1.5"
            disabled={!dirty}
            onClick={() => void save()}
            title="Save (⌘/Ctrl+S)"
          >
            <Save className="size-4" />
            Save
          </Button>
        </div>
      </header>

      <PanelGroup
        direction="horizontal"
        autoSaveId="gamut.layout.files"
        className="flex min-h-0 flex-1"
      >
        <Panel defaultSize={28} minSize={15} className="min-w-0">
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
              <ModeButton
                active={filesPanel === "tree"}
                onClick={() => setFilesPanel("tree")}
                title="File tree"
              >
                <FolderTree className="size-4" />
              </ModeButton>
              <ModeButton
                active={filesPanel === "search"}
                onClick={() => setFilesPanel("search")}
                title="Search (⌘/Ctrl+⇧+F)"
              >
                <Search className="size-4" />
              </ModeButton>
            </div>
            {filesPanel === "search" ? (
              <div className="min-h-0 flex-1">
                <SearchPanel repoId={repoId} onOpenResult={openResult} />
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto py-1">
                <RepoTree
                  repoId={repoId}
                  selectedPath={selectedPath}
                  onSelect={selectFile}
                  onDeleted={onTreeDeleted}
                  onRenamed={onTreeRenamed}
                  changes={changes}
                  groupRelativePrefix={groupRelativePrefix}
                />
              </div>
            )}
          </div>
        </Panel>

        <ResizeHandle />

        <Panel defaultSize={72} minSize={30} className="min-w-0">
          {selectedPath == null ? (
            <div className="flex h-full items-center justify-center p-4 text-center text-sm text-[var(--color-muted-foreground)]">
              Select a file to open it.
            </div>
          ) : isImage ? (
            <ImageView repoId={repoId} path={selectedPath} />
          ) : content.isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="animate-spin text-[var(--color-muted-foreground)]" />
            </div>
          ) : content.isError ? (
            <div className="flex h-full items-center justify-center p-4 text-center text-sm text-[var(--color-destructive)]">
              {String(content.error)}
            </div>
          ) : content.data?.too_large ? (
            <div className="flex h-full items-center justify-center p-4 text-center text-sm text-[var(--color-muted-foreground)]">
              File is too large to edit here (over 2 MB).
            </div>
          ) : content.data?.is_binary ? (
            <div className="flex h-full items-center justify-center p-4 text-center text-sm text-[var(--color-muted-foreground)]">
              Binary file — not shown.
            </div>
          ) : content.data?.encoding_error ? (
            <div className="flex h-full items-center justify-center p-4 text-center text-sm text-[var(--color-muted-foreground)]">
              Not a UTF-8 text file — not shown to avoid corrupting it on save.
            </div>
          ) : isMarkdown && mdPreview ? (
            <div className="h-full overflow-auto px-6 py-4">
              <Markdown>{value}</Markdown>
            </div>
          ) : (
            <Editor
              height="100%"
              theme={isDark ? GITHUB_DARK : "light"}
              path={selectedPath}
              language={languageFor(selectedPath)}
              value={value}
              onChange={(v) => setValue(v ?? "")}
              onMount={(editor) => {
                editorRef.current = editor;
                setEditorReady(true);
                setEditor(editor);
                // Right-click → "Send to Terminal": stage a GitHub-style
                // `path#Lstart-Lend` reference for the current selection in the
                // active terminal (#199). No selection → path with no lines.
                editor.addAction({
                  id: "gamut.sendToTerminal",
                  label: "Send to Terminal",
                  contextMenuGroupId: "9_cutcopypaste",
                  contextMenuOrder: 3,
                  run: (ed) => {
                    const path = selectedPathRef.current;
                    if (!path) return;
                    const sel = ed.getSelection();
                    let startLine: number | undefined;
                    let endLine: number | undefined;
                    if (sel && !sel.isEmpty()) {
                      startLine = sel.startLineNumber;
                      endLine = sel.endLineNumber;
                      // A full-line drag ends at column 1 of the next line; that
                      // trailing line isn't really part of the selection, so
                      // don't let it inflate the range.
                      if (sel.endColumn === 1 && endLine > startLine) endLine -= 1;
                    } else if (sel) {
                      // Collapsed caret → reference just the line it sits on.
                      startLine = sel.startLineNumber;
                    }
                    sendToActiveTerminal(fileReference(path, startLine, endLine));
                  },
                });
              }}
              options={{
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                ...editorPrefs,
              }}
            />
          )}
        </Panel>
      </PanelGroup>
    </div>
  );
}
