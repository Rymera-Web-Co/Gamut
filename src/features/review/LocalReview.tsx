import { useEffect, useRef, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { FileCheck2, Loader2, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { FileTree } from "@/components/FileTree";
import { Panel, PanelGroup, ResizeHandle } from "@/components/ui/resizable";
import type { DraftComment, FileChange, ReviewSource } from "@/lib/ipc";
import { isDarkTheme, languageFor } from "@/lib/lang";
import { GITHUB_DARK } from "@/lib/monaco";
import { useDiffEditorPrefs } from "@/lib/settings";
import { useReviewDrafts, useDraftsFor } from "@/store/reviewDrafts";
import { useUiStore } from "@/store/ui";
import { useMentionables, usePrComment, useReviewFileDiff, useReviewFiles } from "./api";
import { InlineCommentBox } from "./InlineCommentBox";

/** Context needed to attach PR review comments to the diff. */
type PrContext = { number: number; headSha: string };

type Composer = { startLine: number; endLine: number };

export function LocalReview({
  repoId,
  source,
  pr,
}: {
  repoId: number;
  source: ReviewSource;
  /** When set (branch mode + matching PR), lines become commentable. */
  pr?: PrContext;
}) {
  const review = useReviewFiles(repoId, source);
  const diffPrefs = useDiffEditorPrefs();
  const setView = useUiStore((s) => s.setView);
  const setFilesPath = useUiStore((s) => s.setFilesPath);
  const [selected, setSelected] = useState<FileChange | null>(null);

  // Reset selection when the source or file set changes.
  useEffect(() => {
    setSelected(null);
  }, [source, repoId]);

  const diff = useReviewFileDiff(repoId, source, selected?.path ?? null, selected?.old_path);

  // ---- Inline PR comments (only meaningful when a PR matches) ----
  const mentionables = useMentionables(repoId, !!pr);
  const postComment = usePrComment(repoId);
  const addDraft = useReviewDrafts((s) => s.add);
  const drafts = useDraftsFor(repoId, pr?.number ?? -1);

  const modifiedRef = useRef<Monaco.editor.ICodeEditor | null>(null);
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  // Latest values for use inside Monaco event callbacks (avoid stale closures).
  const prRef = useRef<PrContext | undefined>(pr);
  prRef.current = pr;
  const pathRef = useRef<string | undefined>(selected?.path);
  pathRef.current = selected?.path;

  const [composer, setComposer] = useState<Composer | null>(null);
  const composerRef = useRef<Composer | null>(null);
  composerRef.current = composer;
  // Viewport-relative Y (px) where the composer overlay is pinned.
  const [overlayTop, setOverlayTop] = useState(0);

  function updateOverlayTop() {
    const modified = modifiedRef.current;
    const c = composerRef.current;
    if (!modified || !c) return;
    setOverlayTop(modified.getTopForLineNumber(c.endLine + 1) - modified.getScrollTop());
  }

  function openComposer(startLine: number, endLine: number) {
    const modified = modifiedRef.current;
    if (!modified) return;
    setComposer({ startLine, endLine });
    composerRef.current = { startLine, endLine };
    // Center the line so there's room for the overlay, then pin under it.
    modified.revealLineInCenter(endLine);
    requestAnimationFrame(updateOverlayTop);
  }

  function closeComposer() {
    composerRef.current = null;
    setComposer(null);
  }

  // Tear down the composer when the open file changes.
  useEffect(() => {
    closeComposer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.path, source]);

  function handleMount(editor: Monaco.editor.IStandaloneDiffEditor, monaco: typeof Monaco) {
    const modified = editor.getModifiedEditor();
    modifiedRef.current = modified;
    decorationsRef.current = modified.createDecorationsCollection();

    // Keep the overlay pinned to its line as the diff scrolls.
    modified.onDidScrollChange(() => {
      if (composerRef.current) updateOverlayTop();
    });

    // Show a "+" in the glyph margin on the hovered line.
    modified.onMouseMove((e) => {
      const line = e.target.position?.lineNumber;
      if (!prRef.current || line == null) {
        decorationsRef.current?.clear();
        return;
      }
      decorationsRef.current?.set([
        {
          range: new monaco.Range(line, 1, line, 1),
          options: {
            glyphMarginClassName: "comment-add-glyph",
            glyphMarginHoverMessage: { value: "Add a review comment" },
          },
        },
      ]);
    });
    modified.onMouseLeave(() => decorationsRef.current?.clear());

    // Click the "+" to open the composer (covering the current selection if any).
    modified.onMouseDown((e) => {
      if (
        e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        !prRef.current ||
        !pathRef.current
      ) {
        return;
      }
      const clicked = e.target.position?.lineNumber;
      if (clicked == null) return;
      const sel = modified.getSelection();
      if (sel && !sel.isEmpty() && clicked >= sel.startLineNumber && clicked <= sel.endLineNumber) {
        openComposer(sel.startLineNumber, sel.endLineNumber);
      } else {
        openComposer(clicked, clicked);
      }
    });
  }

  function draftFor(body: string): DraftComment | null {
    const path = pathRef.current;
    if (!composer || !path) return null;
    const multi = composer.startLine !== composer.endLine;
    return {
      path,
      line: composer.endLine,
      side: "RIGHT",
      start_line: multi ? composer.startLine : undefined,
      start_side: multi ? "RIGHT" : undefined,
      body,
    };
  }

  function submitComment(body: string) {
    const comment = draftFor(body);
    if (!comment || !pr) return;
    postComment.mutate(
      { number: pr.number, commitId: pr.headSha, comment },
      { onSuccess: closeComposer },
    );
  }

  function stashDraft(body: string) {
    const comment = draftFor(body);
    if (!comment || !pr) return;
    addDraft(repoId, pr.number, comment);
    closeComposer();
  }

  if (review.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="animate-spin text-[var(--color-muted-foreground)]" />
      </div>
    );
  }

  if (review.isError) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--color-destructive)]">
        {String(review.error)}
      </div>
    );
  }

  const data = review.data;
  if (!data || data.files.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <FileCheck2 className="size-8 text-[var(--color-muted-foreground)]" />
        <p className="text-sm text-[var(--color-muted-foreground)]">
          No changes to review
          {data ? ` (${data.base_label} → ${data.head_label})` : ""}.
        </p>
      </div>
    );
  }

  const lineLabel = composer
    ? composer.startLine !== composer.endLine
      ? `R${composer.startLine}–R${composer.endLine}`
      : `R${composer.endLine}`
    : "";

  return (
    <PanelGroup
      direction="horizontal"
      autoSaveId="gamut.layout.review-local"
      className="flex h-full min-h-0"
    >
      <Panel defaultSize={28} minSize={15} maxSize={55} className="flex min-w-0 flex-col">
        <div className="border-b px-3 py-1.5 text-xs text-[var(--color-muted-foreground)]">
          <span className="font-mono">{data.base_label}</span> →{" "}
          <span className="font-mono">{data.head_label}</span> · {data.files.length} file
          {data.files.length === 1 ? "" : "s"}
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          <FileTree files={data.files} onOpen={setSelected} selectedPath={selected?.path} />
        </div>
      </Panel>

      <ResizeHandle />

      <Panel className="min-w-0">
        <div className="flex h-full flex-col">
          {selected && (
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-muted-foreground)]">
                {selected.path}
              </span>
              {/* Deleted files no longer exist on disk, so there's nothing to edit. */}
              {selected.status !== "deleted" && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1.5"
                  title="Edit this file in the Files tab"
                  onClick={() => {
                    setFilesPath(selected.path);
                    setView("files");
                  }}
                >
                  <Pencil className="size-3.5" />
                  Edit
                </Button>
              )}
            </div>
          )}
          <div className="min-h-0 flex-1">
            {!selected ? (
              <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted-foreground)]">
                Select a file to see its diff.
              </div>
            ) : diff.isLoading || !diff.data ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="animate-spin text-[var(--color-muted-foreground)]" />
              </div>
            ) : diff.data.is_binary ? (
              <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted-foreground)]">
                Binary file — diff not shown.
              </div>
            ) : (
              <div className="relative h-full overflow-hidden">
                <DiffEditor
                  height="100%"
                  theme={isDarkTheme() ? GITHUB_DARK : "light"}
                  language={languageFor(selected.path)}
                  original={diff.data.old_text ?? ""}
                  modified={diff.data.new_text ?? ""}
                  onMount={handleMount}
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    glyphMargin: !!pr,
                    ...diffPrefs,
                  }}
                />
                {composer && (
                  <div className="absolute inset-x-2 z-20" style={{ top: Math.max(0, overlayTop) }}>
                    <InlineCommentBox
                      lineLabel={lineLabel}
                      mentions={mentionables.data ?? []}
                      hasDrafts={drafts.length > 0}
                      posting={postComment.isPending}
                      onCancel={closeComposer}
                      onComment={submitComment}
                      onAddDraft={stashDraft}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </Panel>
    </PanelGroup>
  );
}
