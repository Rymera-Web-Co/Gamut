import { useState } from "react";
import { VList } from "virtua";
import { Copy, GitBranch } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, PanelGroup, ResizeHandle } from "@/components/ui/resizable";
import type { CommitRow, FileChange, RefLabel } from "@/lib/ipc";
import { copy } from "@/lib/clipboard";
import { formatDate, relativeTime } from "@/lib/format";
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
        "group flex w-max min-w-full cursor-pointer items-center gap-2 border-b pr-3 text-sm",
        selected ? "bg-[var(--color-accent)]" : "hover:bg-[var(--color-accent)]",
      )}
      style={{ height: ROW_HEIGHT }}
    >
      <CommitGraph row={commit} width={width} />
      <div className="flex shrink-0 items-center gap-2">
        {commit.refs.map((r) => (
          <RefBadge key={`${r.kind}-${r.name}`} label={r} />
        ))}
        <span className="whitespace-nowrap">{commit.subject}</span>
      </div>
      <div className="min-w-8 flex-1" />
      <span className="shrink-0 whitespace-nowrap text-xs text-[var(--color-muted-foreground)]">
        {commit.author_name}
      </span>
      <span className="w-16 shrink-0 text-right text-xs text-[var(--color-muted-foreground)]">
        {relativeTime(commit.timestamp)}
      </span>
      <button
        title="Copy commit hash"
        onClick={(e) => {
          e.stopPropagation();
          copy(commit.sha, `Copied ${commit.short_sha}`);
        }}
        className="flex w-20 shrink-0 items-center justify-end gap-1 font-mono text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
      >
        <Copy className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
        {commit.short_sha}
      </button>
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
      className="flex w-full items-center gap-3 border-b border-[var(--color-border)] px-3 py-2.5 text-left text-sm hover:bg-[var(--color-accent)]"
    >
      <span
        className="w-4 shrink-0 text-center text-xs font-bold"
        style={{ color: statusColor }}
        title={file.status}
      >
        {file.status[0].toUpperCase()}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
      {file.additions > 0 && (
        <span className="shrink-0 text-xs font-medium text-[#16a34a]">
          +{file.additions}
        </span>
      )}
      {file.deletions > 0 && (
        <span className="shrink-0 text-xs font-medium text-[#dc2626]">
          −{file.deletions}
        </span>
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
        <div className="prose prose-sm dark:prose-invert max-w-none break-words prose-pre:text-xs">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {d.message.trim()}
          </ReactMarkdown>
        </div>
        <p className="mt-3 text-xs text-[var(--color-muted-foreground)]">
          {d.author_name} &lt;{d.author_email}&gt; · {formatDate(d.timestamp)}
        </p>
        <button
          title="Copy commit hash"
          onClick={() => copy(d.sha, `Copied ${d.sha.slice(0, 8)}`)}
          className="mt-1 flex items-center gap-1.5 font-mono text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
        >
          {d.sha}
          <Copy className="size-3" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-2">
        <p className="border-b px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
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
  const repos = useRepos();
  const [limit, setLimit] = useState(PAGE);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const logQuery = useLog(repoId, limit);
  const repo = repos.data?.find((r) => r.id === repoId);

  if (repoId == null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <GitBranch className="size-8 text-[var(--color-muted-foreground)]" />
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Select a repository from the left to view its history.
        </p>
      </div>
    );
  }

  const page = logQuery.data;
  const width = page?.width ?? 1;
  const q = query.trim().toLowerCase();
  // Only offer "load more" on the unfiltered list (it fetches more from the repo).
  const showLoadMore = !!page?.has_more && !q;
  const commits = q
    ? (page?.commits ?? []).filter(
        (c) =>
          c.subject.toLowerCase().includes(q) ||
          c.author_name.toLowerCase().includes(q) ||
          c.sha.startsWith(q),
      )
    : (page?.commits ?? []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <h1 className="text-sm font-semibold">{repo?.name ?? "History"}</h1>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by message, author, or sha…"
          className="ml-2 h-7 max-w-xs"
        />
        <span className="ml-auto shrink-0 text-xs text-[var(--color-muted-foreground)]">
          {page
            ? q
              ? `${commits.length} / ${page.commits.length}`
              : `${page.commits.length} commits`
            : "loading…"}
        </span>
      </header>

      <PanelGroup
        direction="horizontal"
        autoSaveId="gamut.layout.history"
        className="flex min-h-0 flex-1"
      >
        <Panel defaultSize={60} minSize={30} className="flex min-w-0 flex-col">
          <div className="min-h-0 flex-1">
            {commits.length > 0 ? (
              <VList
                style={{ height: "100%", overflowX: "auto" }}
                count={commits.length + (showLoadMore ? 1 : 0)}
              >
                {(i) => {
                  // The "Load more" row is the last item, so it only appears
                  // once the user scrolls to the bottom of the list.
                  if (i >= commits.length) {
                    return (
                      <div
                        key="load-more"
                        className="flex min-w-full justify-center border-t p-2"
                      >
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={logQuery.isFetching}
                          onClick={() => setLimit((l) => l + PAGE)}
                        >
                          {logQuery.isFetching ? "Loading…" : "Load more"}
                        </Button>
                      </div>
                    );
                  }
                  const c = commits[i];
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
        </Panel>

        <ResizeHandle />

        <Panel defaultSize={40} minSize={20} className="min-w-0">
          {selectedSha ? (
            <CommitDetailPanel repoId={repoId} sha={selectedSha} />
          ) : (
            <div className="flex h-full items-center justify-center p-4 text-center text-sm text-[var(--color-muted-foreground)]">
              Select a commit to see its changes.
            </div>
          )}
        </Panel>
      </PanelGroup>
    </div>
  );
}
