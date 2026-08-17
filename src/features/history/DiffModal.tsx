import { useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";

import { CodeDiffEditor } from "@/components/MonacoEditor";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import type { BlameHunk } from "@/lib/ipc";
import { isDarkTheme, languageFor } from "@/lib/lang";
import { GAMUT_DARK } from "@/lib/monacoTheme";
import { useDiffEditorPrefs, useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useBlame, useFileDiff } from "./api";

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

function BlameView({ text, hunks, wrap }: { text: string; hunks: BlameHunk[]; wrap: boolean }) {
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
                <td
                  className={cn(
                    "px-2 py-0.5",
                    wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
                  )}
                >
                  {line || " "}
                </td>
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
  const diffPrefs = useDiffEditorPrefs();
  const wordWrap = useSettings((s) => s.values.editorWordWrap);

  const isDark = isDarkTheme();

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerContent className="h-[70vh] gap-2 px-3 pb-3">
        <div className="flex items-center justify-between gap-4 px-1 pt-1">
          <DrawerTitle className="min-w-0 flex-1 truncate font-mono text-sm">{path}</DrawerTitle>
          <div className="flex items-center gap-1">
            {(["diff", "blame"] as const).map((m) => (
              <Button
                key={m}
                size="sm"
                variant={mode === m ? "secondary" : "ghost"}
                onClick={() => setMode(m)}
                className="capitalize"
              >
                {m}
              </Button>
            ))}
            <DrawerClose asChild>
              <Button size="icon" variant="ghost" className="size-8" aria-label="Close">
                <X />
              </Button>
            </DrawerClose>
          </div>
        </div>

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
            <CodeDiffEditor
              height="100%"
              theme={isDark ? GAMUT_DARK : "light"}
              language={languageFor(path)}
              original={diff.data?.old_text ?? ""}
              modified={diff.data?.new_text ?? ""}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                ...diffPrefs,
              }}
            />
          ) : blame.isLoading || !blame.data ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="animate-spin text-[var(--color-muted-foreground)]" />
            </div>
          ) : (
            <BlameView text={diff.data?.new_text ?? ""} hunks={blame.data} wrap={wordWrap} />
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
