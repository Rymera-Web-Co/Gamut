import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Editor } from "@monaco-editor/react";
import { FolderOpen, FolderTree, GitCompare, Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Panel, PanelGroup, ResizeHandle } from "@/components/ui/resizable";
import { ipc } from "@/lib/ipc";
import { isDarkTheme, languageFor } from "@/lib/lang";
import { GITHUB_DARK } from "@/lib/monaco";
import { toast } from "@/store/toast";
import { useUiStore } from "@/store/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useRepos } from "@/features/repos/api";
import { useFileContent, useWorktreeStatus } from "./api";
import { RepoTree, type TreeChanges } from "./RepoTree";

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

export function FilesView() {
  const repoId = useUiStore((s) => s.activeRepoId);
  const setView = useUiStore((s) => s.setView);
  const setReviewMode = useUiStore((s) => s.setReviewMode);
  const filesPath = useUiStore((s) => s.filesPath);
  const setFilesPath = useUiStore((s) => s.setFilesPath);
  const repos = useRepos();
  const repo = repos.data?.find((r) => r.id === repoId);
  const queryClient = useQueryClient();

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [baseline, setBaseline] = useState("");
  // Which file the editor buffer currently belongs to — guards against the
  // content query clobbering unsaved edits on refetch.
  const loadedRef = useRef<string | null>(null);

  const content = useFileContent(repoId, selectedPath);
  const editable = content.data?.text != null;
  const dirty = editable && value !== baseline;

  // Map changed working-tree paths so the tree can highlight files (and the
  // directories that contain them).
  const status = useWorktreeStatus(repoId);
  const changes = useMemo<TreeChanges>(() => {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    const all = [
      ...(status.data?.staged ?? []),
      ...(status.data?.unstaged ?? []),
    ];
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
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

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
          <div className="h-full overflow-auto py-1">
            <RepoTree
              repoId={repoId}
              selectedPath={selectedPath}
              onSelect={selectFile}
              onDeleted={onTreeDeleted}
              changes={changes}
            />
          </div>
        </Panel>

        <ResizeHandle />

        <Panel defaultSize={72} minSize={30} className="min-w-0">
          {selectedPath == null ? (
            <div className="flex h-full items-center justify-center p-4 text-center text-sm text-[var(--color-muted-foreground)]">
              Select a file to open it.
            </div>
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
          ) : (
            <Editor
              height="100%"
              theme={isDark ? GITHUB_DARK : "light"}
              path={selectedPath}
              language={languageFor(selectedPath)}
              value={value}
              onChange={(v) => setValue(v ?? "")}
              options={{
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontSize: 12,
              }}
            />
          )}
        </Panel>
      </PanelGroup>
    </div>
  );
}
