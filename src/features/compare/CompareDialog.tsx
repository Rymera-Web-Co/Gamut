import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DiffEditor } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { ArrowLeftRight, FolderOpen, Loader2, Save } from "lucide-react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ipc, pickFile, type CompareResult } from "@/lib/ipc";
import { isDarkTheme, languageFor } from "@/lib/lang";
import { GITHUB_DARK } from "@/lib/monaco";
import { useDiffEditorPrefs } from "@/lib/settings";
import { useRepos } from "@/features/repos/api";
import { useUiStore } from "@/store/ui";
import { toast } from "@/store/toast";

type Mode = "files" | "refs" | "revision";

/** Working-tree sentinel for the ref dropdowns (maps to a null ref backend-side). */
const WORKTREE = "\0worktree";

const RECENT_REFS_KEY = "gamut.compare.recentRefs";

function recentRefs(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_REFS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * File Compare (#130). Three modes in one dialog: two arbitrary files, one repo
 * file across two refs, or a working/HEAD file against a chosen revision. The
 * result renders in the same Monaco diff viewer used by Review/History.
 */
export function CompareDialog() {
  const seed = useUiStore((s) => s.compare);
  const close = useUiStore((s) => s.closeCompare);
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  const open = seed != null;

  // A repo is needed for the ref/revision modes; prefer the seed, else the
  // active repo.
  const repoId = seed?.repoId ?? activeRepoId ?? null;
  const repos = useRepos();
  const repoName = repos.data?.find((r) => r.id === repoId)?.name ?? null;

  const [mode, setMode] = useState<Mode>("files");
  const [leftPath, setLeftPath] = useState("");
  const [rightPath, setRightPath] = useState("");
  const [path, setPath] = useState("");
  const [leftRef, setLeftRef] = useState("");
  const [rightRef, setRightRef] = useState("");
  // Left side for the "with revision" mode: working tree or HEAD.
  const [revLeft, setRevLeft] = useState<typeof WORKTREE | "HEAD">(WORKTREE);

  const [result, setResult] = useState<CompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Recently-used refs, in React state so newly-remembered ones show up in the
  // datalist immediately (localStorage alone isn't a render dependency).
  const [recent, setRecent] = useState<string[]>(recentRefs);

  function rememberRefs(...refs: string[]) {
    const real = refs.filter((r) => r && r !== WORKTREE);
    if (!real.length) return;
    const next = [...new Set([...real, ...recent])].slice(0, 12);
    localStorage.setItem(RECENT_REFS_KEY, JSON.stringify(next));
    setRecent(next);
  }

  // (Re)initialize each time the dialog opens with a fresh seed.
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError(null);
    setLeftRef("");
    setRightRef("");
    setRevLeft(WORKTREE);

    // "Compare with Selected" (VSCode-style): two absolute paths, run at once.
    if (seed?.files) {
      const { leftPath: l, rightPath: r } = seed.files;
      setMode("files");
      setLeftPath(l);
      setRightPath(r);
      setPath("");
      setLoading(true);
      ipc
        .compareFiles(l, r)
        .then(setResult)
        .catch((e) => setError(String(e)))
        .finally(() => setLoading(false));
      return;
    }

    setLeftPath("");
    setRightPath("");
    setPath(seed?.path ?? "");
    // A seeded file defaults to the across-refs flow; otherwise compare two files.
    setMode(seed?.path ? "refs" : "files");
  }, [open, seed]);

  // Branch + tag names for the ref pickers (only when a repo is in play).
  const refsQuery = useQuery({
    queryKey: ["compare-refs", repoId],
    queryFn: async () => {
      const [branches, tags] = await Promise.all([
        ipc.listBranches(repoId!),
        ipc.listGitTags(repoId!),
      ]);
      return [...branches.map((b) => b.name), ...tags];
    },
    enabled: open && repoId != null && mode !== "files",
  });

  const refOptions = useMemo(() => {
    const known = refsQuery.data ?? [];
    return [...new Set([...recent, ...known])];
  }, [refsQuery.data, recent]);

  const canCompare =
    mode === "files"
      ? leftPath.trim() !== "" && rightPath.trim() !== ""
      : repoId != null &&
        path.trim() !== "" &&
        (mode === "refs"
          ? leftRef.trim() !== "" && rightRef.trim() !== ""
          : rightRef.trim() !== "");

  async function runCompare() {
    setLoading(true);
    setError(null);
    try {
      let res: CompareResult;
      if (mode === "files") {
        res = await ipc.compareFiles(leftPath.trim(), rightPath.trim());
      } else if (mode === "refs") {
        res = await ipc.compareRefs(repoId!, path.trim(), leftRef.trim(), rightRef.trim());
        rememberRefs(leftRef.trim(), rightRef.trim());
      } else {
        const left = revLeft === "HEAD" ? "HEAD" : null;
        res = await ipc.compareRefs(repoId!, path.trim(), left, rightRef.trim());
        rememberRefs(rightRef.trim());
      }
      setResult(res);
    } catch (e) {
      setError(String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  function swapSides() {
    if (!result) return;
    setResult({
      ...result,
      left_text: result.right_text,
      right_text: result.left_text,
      left_label: result.right_label,
      right_label: result.left_label,
    });
  }

  const browse = (set: (p: string) => void) => async () => {
    const p = await pickFile("Choose a file to compare");
    if (p) set(p);
  };

  // Language hint for syntax highlighting: derive from whichever path we have.
  const lang = languageFor(result?.right_label ?? path ?? rightPath ?? "");

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex h-[85vh] w-[90vw] max-w-[1400px] flex-col gap-3 p-4">
        <DialogHeader>
          <DialogTitle>Compare files</DialogTitle>
        </DialogHeader>

        {/* Mode selector. */}
        <div className="flex shrink-0 gap-1 rounded-md border border-[var(--color-border)] p-0.5 text-xs">
          {(
            [
              { m: "files", label: "Two files" },
              { m: "refs", label: "Across refs" },
              { m: "revision", label: "With revision" },
            ] as const
          ).map(({ m, label }) => {
            const disabled = m !== "files" && repoId == null;
            return (
              <button
                key={m}
                disabled={disabled}
                title={disabled ? "Open a repository to compare its files" : undefined}
                onClick={() => {
                  setMode(m);
                  setResult(null);
                }}
                className={`flex-1 rounded px-2 py-1 ${
                  mode === m
                    ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
                    : "text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] disabled:opacity-40 disabled:hover:bg-transparent"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Inputs for the active mode. */}
        <div className="shrink-0 space-y-2">
          {mode === "files" && (
            <>
              <PathRow
                label="File A"
                value={leftPath}
                onChange={setLeftPath}
                onBrowse={browse(setLeftPath)}
              />
              <PathRow
                label="File B"
                value={rightPath}
                onChange={setRightPath}
                onBrowse={browse(setRightPath)}
              />
            </>
          )}

          {mode !== "files" && (
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-right text-xs text-[var(--color-muted-foreground)]">
                File
              </span>
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="repo-relative/path.ext"
                className="h-8 font-mono text-xs"
              />
              {repoName && (
                <span className="shrink-0 text-[10px] text-[var(--color-muted-foreground)]">
                  in {repoName}
                </span>
              )}
            </div>
          )}

          {mode === "refs" && (
            <div className="flex gap-2">
              <RefRow label="Left" value={leftRef} onChange={setLeftRef} options={refOptions} />
              <RefRow label="Right" value={rightRef} onChange={setRightRef} options={refOptions} />
            </div>
          )}

          {mode === "revision" && (
            <div className="flex gap-2">
              <div className="flex flex-1 items-center gap-2">
                <span className="w-16 shrink-0 text-right text-xs text-[var(--color-muted-foreground)]">
                  Left
                </span>
                <select
                  value={revLeft}
                  onChange={(e) => setRevLeft(e.target.value as typeof WORKTREE | "HEAD")}
                  className="h-8 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-2 text-xs"
                >
                  <option value={WORKTREE}>Working tree</option>
                  <option value="HEAD">HEAD</option>
                </select>
              </div>
              <RefRow label="Right" value={rightRef} onChange={setRightRef} options={refOptions} />
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            {error && (
              <span className="mr-auto truncate text-xs text-[var(--color-destructive)]">
                {error}
              </span>
            )}
            <Button size="sm" disabled={!canCompare || loading} onClick={runCompare}>
              {loading && <Loader2 className="animate-spin" />}
              Compare
            </Button>
          </div>
        </div>

        {/* Result. */}
        <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-[var(--color-border)]">
          {result ? (
            // Only the two-files mode has writable sides — ref/working-tree
            // blobs aren't files you can save back to (#130).
            <ResultView
              result={result}
              lang={lang}
              onSwap={swapSides}
              editable={mode === "files"}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-[var(--color-muted-foreground)]">
              Pick what to compare, then press Compare.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResultView({
  result,
  lang,
  onSwap,
  editable,
}: {
  result: CompareResult;
  lang: string;
  onSwap: () => void;
  /** Two-files mode: both sides are real on-disk files, so allow editing+saving. */
  editable: boolean;
}) {
  const diffPrefs = useDiffEditorPrefs();
  const origRef = useRef<Monaco.editor.ICodeEditor | null>(null);
  const modRef = useRef<Monaco.editor.ICodeEditor | null>(null);
  const [leftDirty, setLeftDirty] = useState(false);
  const [rightDirty, setRightDirty] = useState(false);
  const [saving, setSaving] = useState<"left" | "right" | null>(null);

  // In two-files mode the side labels ARE the absolute file paths (compare_files
  // sets them so), and they swap with Swap sides — so save straight to them.
  const savable = editable && !result.is_binary;

  // A fresh comparison/swap remounts the diff editor (keyed below) with new
  // content; clear the dirty flags to match.
  useEffect(() => {
    setLeftDirty(false);
    setRightDirty(false);
  }, [result]);

  function handleMount(editor: Monaco.editor.IStandaloneDiffEditor) {
    const orig = editor.getOriginalEditor();
    const mod = editor.getModifiedEditor();
    origRef.current = orig;
    modRef.current = mod;
    orig.onDidChangeModelContent(() => setLeftDirty(orig.getValue() !== (result.left_text ?? "")));
    mod.onDidChangeModelContent(() => setRightDirty(mod.getValue() !== (result.right_text ?? "")));
  }

  async function save(side: "left" | "right") {
    const path = side === "left" ? result.left_label : result.right_label;
    const editor = side === "left" ? origRef.current : modRef.current;
    if (!editor) return;
    setSaving(side);
    try {
      await ipc.writeCompareFile(path, editor.getValue());
      if (side === "left") setLeftDirty(false);
      else setRightDirty(false);
      toast.success(`Saved ${path}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(null);
    }
  }

  const saveBtn = (side: "left" | "right", dirty: boolean) =>
    savable && dirty ? (
      <button
        title={`Save ${side === "left" ? result.left_label : result.right_label}`}
        onClick={() => void save(side)}
        disabled={saving === side}
        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[var(--color-primary)] hover:bg-[var(--color-accent)] disabled:opacity-40"
      >
        {saving === side ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Save className="size-3" />
        )}
        Save
      </button>
    ) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-sidebar)] px-2 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono" title={result.left_label}>
          {result.left_label}
        </span>
        {saveBtn("left", leftDirty)}
        <button
          title="Swap sides"
          onClick={onSwap}
          className="shrink-0 rounded p-1 text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
        >
          <ArrowLeftRight className="size-3.5" />
        </button>
        {saveBtn("right", rightDirty)}
        <span className="min-w-0 flex-1 truncate text-right font-mono" title={result.right_label}>
          {result.right_label}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        {result.is_binary ? (
          <Centered>Binary file — content differs.</Centered>
        ) : result.identical && !editable ? (
          <Centered>Files are identical.</Centered>
        ) : (
          <DiffEditor
            // Remount on a new comparison/swap so editor content + dirty reset.
            key={`${result.left_label} ${result.right_label}`}
            height="100%"
            theme={isDarkTheme() ? GITHUB_DARK : "light"}
            language={lang}
            original={result.left_text ?? ""}
            modified={result.right_text ?? ""}
            onMount={savable ? handleMount : undefined}
            options={{
              readOnly: !savable,
              originalEditable: savable,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              ...diffPrefs,
            }}
          />
        )}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted-foreground)]">
      {children}
    </div>
  );
}

function PathRow({
  label,
  value,
  onChange,
  onBrowse,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBrowse: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-right text-xs text-[var(--color-muted-foreground)]">
        {label}
      </span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="/absolute/path/to/file"
        className="h-8 font-mono text-xs"
      />
      <Button size="sm" variant="outline" onClick={onBrowse} className="shrink-0">
        <FolderOpen /> Browse…
      </Button>
    </div>
  );
}

function RefRow({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  const listId = `compare-refs-${label}`;
  return (
    <div className="flex flex-1 items-center gap-2">
      <span className="w-16 shrink-0 text-right text-xs text-[var(--color-muted-foreground)]">
        {label}
      </span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="branch, tag or sha"
        list={listId}
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="h-8 font-mono text-xs"
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </div>
  );
}
