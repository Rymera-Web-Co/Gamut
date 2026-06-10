import { useMemo, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { BlameHunk } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useBlame, useFileDiff } from "./api";

const LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  rs: "rust",
  py: "python",
  go: "go",
  java: "java",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  scss: "scss",
  html: "html",
  json: "json",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  sql: "sql",
  toml: "ini",
};

function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANG[ext] ?? "plaintext";
}

/** Build a per-line lookup of which blame hunk owns each (1-based) line. */
function blameByLine(hunks: BlameHunk[]): Map<number, { hunk: BlameHunk; first: boolean }> {
  const map = new Map<number, { hunk: BlameHunk; first: boolean }>();
  for (const h of hunks) {
    for (let i = 0; i < h.line_count; i++) {
      map.set(h.start_line + i, { hunk: h, first: i === 0 });
    }
  }
  return map;
}

function BlameView({
  text,
  hunks,
}: {
  text: string;
  hunks: BlameHunk[];
}) {
  const byLine = useMemo(() => blameByLine(hunks), [hunks]);
  const lines = useMemo(() => text.split("\n"), [text]);

  return (
    <div className="h-full overflow-auto font-mono text-xs">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, idx) => {
            const lineNo = idx + 1;
            const info = byLine.get(lineNo);
            return (
              <tr key={lineNo} className="align-top">
                <td className="w-44 select-none border-r px-2 py-0.5 text-[var(--color-muted-foreground)]">
                  {info?.first && (
                    <span title={info.hunk.sha}>
                      {info.hunk.short_sha} · {info.hunk.author}
                    </span>
                  )}
                </td>
                <td className="w-10 select-none px-2 py-0.5 text-right text-[var(--color-muted-foreground)]">
                  {lineNo}
                </td>
                <td className="whitespace-pre px-2 py-0.5">{line || " "}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DiffModal({
  repoId,
  sha,
  path,
  oldPath,
  onClose,
}: {
  repoId: number;
  sha: string;
  path: string;
  oldPath: string | null;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"diff" | "blame">("diff");
  const diff = useFileDiff(repoId, sha, path, oldPath);
  const blame = useBlame(repoId, sha, path, mode === "blame");

  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[80vh] max-w-[90vw] flex-col gap-3">
        <DialogHeader className="flex-row items-center justify-between gap-4 pr-8">
          <DialogTitle className="truncate font-mono text-sm">{path}</DialogTitle>
          <div className="flex gap-1">
            {(["diff", "blame"] as const).map((m) => (
              <Button
                key={m}
                size="sm"
                variant={mode === m ? "secondary" : "ghost"}
                onClick={() => setMode(m)}
                className={cn("capitalize")}
              >
                {m}
              </Button>
            ))}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
          {diff.isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="animate-spin text-[var(--color-muted-foreground)]" />
            </div>
          ) : diff.data?.is_binary ? (
            <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted-foreground)]">
              Binary file — diff not shown.
            </div>
          ) : mode === "diff" ? (
            <DiffEditor
              height="100%"
              theme={isDark ? "vs-dark" : "light"}
              language={languageFor(path)}
              original={diff.data?.old_text ?? ""}
              modified={diff.data?.new_text ?? ""}
              options={{
                readOnly: true,
                renderSideBySide: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontSize: 12,
              }}
            />
          ) : blame.isLoading || !blame.data ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="animate-spin text-[var(--color-muted-foreground)]" />
            </div>
          ) : (
            <BlameView text={diff.data?.new_text ?? ""} hunks={blame.data} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
