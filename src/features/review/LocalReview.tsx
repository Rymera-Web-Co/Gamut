import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { FileCheck2, Loader2 } from "lucide-react";

import { FileTree } from "@/components/FileTree";
import { Panel, PanelGroup, ResizeHandle } from "@/components/ui/resizable";
import type { FileChange, ReviewSource } from "@/lib/ipc";
import { isDarkTheme, languageFor } from "@/lib/lang";
import { GITHUB_DARK } from "@/lib/monaco";
import { useReviewFileDiff, useReviewFiles } from "./api";

export function LocalReview({
  repoId,
  source,
}: {
  repoId: number;
  source: ReviewSource;
}) {
  const review = useReviewFiles(repoId, source);
  const [selected, setSelected] = useState<FileChange | null>(null);

  // Reset selection when the source or file set changes.
  useEffect(() => {
    setSelected(null);
  }, [source, repoId]);

  const diff = useReviewFileDiff(
    repoId,
    source,
    selected?.path ?? null,
    selected?.old_path,
  );

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

  return (
    <PanelGroup
      direction="horizontal"
      autoSaveId="gamut.layout.review-local"
      className="flex h-full min-h-0"
    >
      <Panel defaultSize={28} minSize={15} maxSize={55} className="flex min-w-0 flex-col">
        <div className="border-b px-3 py-1.5 text-xs text-[var(--color-muted-foreground)]">
          <span className="font-mono">{data.base_label}</span> →{" "}
          <span className="font-mono">{data.head_label}</span> · {data.files.length}{" "}
          file{data.files.length === 1 ? "" : "s"}
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          <FileTree
            files={data.files}
            onOpen={setSelected}
            selectedPath={selected?.path}
          />
        </div>
      </Panel>

      <ResizeHandle />

      <Panel className="min-w-0">
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
          <DiffEditor
            height="100%"
            theme={isDarkTheme() ? GITHUB_DARK : "light"}
            language={languageFor(selected.path)}
            original={diff.data.old_text ?? ""}
            modified={diff.data.new_text ?? ""}
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 12,
            }}
          />
        )}
      </Panel>
    </PanelGroup>
  );
}
