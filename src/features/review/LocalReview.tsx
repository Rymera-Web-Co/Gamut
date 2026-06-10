import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { FileCheck2, Loader2 } from "lucide-react";

import type { FileChange, ReviewSource } from "@/lib/ipc";
import { isDarkTheme, languageFor } from "@/lib/lang";
import { cn } from "@/lib/utils";
import { useReviewFileDiff, useReviewFiles } from "./api";

function statusColor(status: string): string {
  switch (status) {
    case "added":
      return "#16a34a";
    case "deleted":
      return "#dc2626";
    case "renamed":
      return "#2563eb";
    default:
      return "#a16207";
  }
}

function FileRow({
  file,
  selected,
  onSelect,
}: {
  file: FileChange;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 px-2 py-1 text-left text-sm",
        selected ? "bg-[var(--color-accent)]" : "hover:bg-[var(--color-accent)]",
      )}
    >
      <span
        className="w-3 shrink-0 text-center text-xs font-bold"
        style={{ color: statusColor(file.status) }}
        title={file.status}
      >
        {file.status[0].toUpperCase()}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
      {file.additions > 0 && (
        <span className="shrink-0 text-xs text-[#16a34a]">+{file.additions}</span>
      )}
      {file.deletions > 0 && (
        <span className="shrink-0 text-xs text-[#dc2626]">−{file.deletions}</span>
      )}
    </button>
  );
}

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
    <div className="flex h-full min-h-0">
      <div className="flex w-72 shrink-0 flex-col border-r">
        <div className="border-b px-3 py-1.5 text-xs text-[var(--color-muted-foreground)]">
          <span className="font-mono">{data.base_label}</span> →{" "}
          <span className="font-mono">{data.head_label}</span> · {data.files.length}{" "}
          file{data.files.length === 1 ? "" : "s"}
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {data.files.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              selected={selected?.path === f.path}
              onSelect={() => setSelected(f)}
            />
          ))}
        </div>
      </div>

      <div className="min-w-0 flex-1">
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
            theme={isDarkTheme() ? "vs-dark" : "light"}
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
      </div>
    </div>
  );
}
