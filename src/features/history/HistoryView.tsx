import { useState } from "react";
import { VList } from "virtua";
import { GitBranch } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CommitRow, FileChange, RefLabel } from "@/lib/ipc";
import { formatDate, graphColor, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useRepos } from "@/features/repos/api";
import { useUiStore } from "@/store/ui";
import { useCommitDetail, useLog } from "./api";
import { CommitGraph, ROW_HEIGHT } from "./CommitGraph";
import { DiffModal } from "./DiffModal";

const PAGE = 300;

function RefBadge({ label }: { label: RefLabel }) {
  const styles: Record<RefLabel["kind"], string> = {
    head: "border-transparent text-white",
    branch: "border-[var(--color-border)]",
    remote: "border-[var(--color-border)] text-[var(--color-muted-foreground)]",
    tag: "border-transparent text-white",
  };
  const bg =
    label.kind === "head" ? "#16a34a" : label.kind === "tag" ? "#d97706" : undefined;
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-medium leading-none",
        "border",
        styles[label.kind],
      )}
      style={bg ? { background: bg } : undefined}
    >
      {label.name}
    </span>
  );
}

function CommitListRow({
  commit,
  width,
  selected,
  onSelect,
}: {
  commit: CommitRow;
  width: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      role="button"
      onClick={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-2 border-b pr-3 text-sm",
        selected ? "bg-[var(--color-accent)]" : "hover:bg-[var(--color-accent)]",
      )}
      style={{ height: ROW_HEIGHT }}
    >
      <CommitGraph row={commit} width={width} />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {commit.refs.map((r) => (
          <RefBadge key={`${r.kind}-${r.name}`} label={r} />
        ))}
        <span className="truncate">{commit.subject}</span>
      </div>
      <span className="shrink-0 text-xs text-[var(--color-muted-foreground)]">
        {commit.author_name}
      </span>
      <span className="w-16 shrink-0 text-right text-xs text-[var(--color-muted-foreground)]">
        {relativeTime(commit.timestamp)}
      </span>
      <span className="w-16 shrink-0 text-right font-mono text-xs text-[var(--color-muted-foreground)]">
        {commit.short_sha}
      </span>
    </div>
  );
}

function FileRow({ file, onOpen }: { file: FileChange; onOpen: () => void }) {
  const statusColor =
    file.status === "added"
      ? "#16a34a"
      : file.status === "deleted"
        ? "#dc2626"
        : file.status === "renamed"
          ? "#2563eb"
          : "#a16207";
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-[var(--color-accent)]"
    >
      <span
        className="w-3 shrink-0 text-center text-xs font-bold"
        style={{ color: statusColor }}
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

function CommitDetailPanel({
  repoId,
  sha,
}: {
  repoId: number;
  sha: string;
}) {
  const detail = useCommitDetail(repoId, sha);
  const [openFile, setOpenFile] = useState<FileChange | null>(null);

  if (!detail.data) {
    return (
      <div className="p-4 text-sm text-[var(--color-muted-foreground)]">Loading…</div>
    );
  }
  const d = detail.data;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-4">
        <p className="whitespace-pre-wrap text-sm font-medium">{d.message.trim()}</p>
        <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
          {d.author_name} &lt;{d.author_email}&gt; · {formatDate(d.timestamp)}
        </p>
        <p className="mt-1 font-mono text-xs text-[var(--color-muted-foreground)]">{d.sha}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
          {d.files.length} file{d.files.length === 1 ? "" : "s"} changed
        </p>
        {d.files.map((f) => (
          <FileRow key={f.path} file={f} onOpen={() => setOpenFile(f)} />
        ))}
      </div>
      {openFile && (
        <DiffModal
          repoId={repoId}
          sha={sha}
          path={openFile.path}
          oldPath={openFile.old_path}
          onClose={() => setOpenFile(null)}
        />
      )}
    </div>
  );
}

export function HistoryView() {
  const repoId = useUiStore((s) => s.activeRepoId);
  const setView = useUiStore((s) => s.setView);
  const repos = useRepos();
  const [limit, setLimit] = useState(PAGE);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);

  const logQuery = useLog(repoId, limit);
  const repo = repos.data?.find((r) => r.id === repoId);

  if (repoId == null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <GitBranch className="size-8 text-[var(--color-muted-foreground)]" />
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Select a repository to view its history.
        </p>
        <Button variant="outline" size="sm" onClick={() => setView("repos")}>
          Go to Repositories
        </Button>
      </div>
    );
  }

  const page = logQuery.data;
  const width = page?.width ?? 1;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <h1 className="text-sm font-semibold">{repo?.name ?? "History"}</h1>
        {repo?.default_branch && (
          <span
            className="rounded px-1.5 py-0.5 text-xs"
            style={{ background: graphColor(0), color: "white" }}
          >
            {repo.default_branch}
          </span>
        )}
        <span className="ml-auto text-xs text-[var(--color-muted-foreground)]">
          {page ? `${page.commits.length} commits` : "loading…"}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-[3] flex-col border-r">
          <div className="min-h-0 flex-1">
            {page && page.commits.length > 0 ? (
              <VList style={{ height: "100%" }} count={page.commits.length}>
                {(i) => {
                  const c = page.commits[i];
                  return (
                    <div key={c.sha} className="pl-2">
                      <CommitListRow
                        commit={c}
                        width={width}
                        selected={c.sha === selectedSha}
                        onSelect={() => setSelectedSha(c.sha)}
                      />
                    </div>
                  );
                }}
              </VList>
            ) : (
              <p className="p-4 text-sm text-[var(--color-muted-foreground)]">
                {logQuery.isLoading ? "Loading history…" : "No commits."}
              </p>
            )}
          </div>
          {page?.has_more && (
            <div className="border-t p-2 text-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLimit((l) => l + PAGE)}
              >
                Load more
              </Button>
            </div>
          )}
        </div>

        <div className="min-w-0 flex-[2]">
          {selectedSha ? (
            <CommitDetailPanel repoId={repoId} sha={selectedSha} />
          ) : (
            <div className="flex h-full items-center justify-center p-4 text-center text-sm text-[var(--color-muted-foreground)]">
              Select a commit to see its changes.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
