import { useEffect, useRef, useState } from "react";
import { VList, type VListHandle } from "virtua";
import { Copy, Eye, GitBranch } from "lucide-react";

import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { FileTree } from "@/components/FileTree";
import { Input } from "@/components/ui/input";
import { Panel, PanelGroup, ResizeHandle } from "@/components/ui/resizable";
import type { CommitRow, FileChange, RefLabel } from "@/lib/ipc";
import { copy } from "@/lib/clipboard";
import { formatDate, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useRepos, useRepoStatuses } from "@/features/repos/api";
import { Avatar } from "@/features/review/reviewShared";
import { useUiStore } from "@/store/ui";
import { useCommitAvatar, useCommitDetail, useLog } from "./api";
import { CommitGraph, ROW_HEIGHT } from "./CommitGraph";
import { DiffModal } from "./DiffModal";
import { RefPicker } from "./RefPicker";

const PAGE = 300;

function RefBadge({ label }: { label: RefLabel }) {
  const styles: Record<RefLabel["kind"], string> = {
    head: "border-transparent text-white",
    branch: "border-[var(--color-border)]",
    remote: "border-[var(--color-border)] text-[var(--color-muted-foreground)]",
    tag: "border-transparent text-white",
  };
  const bg = label.kind === "head" ? "#16a34a" : label.kind === "tag" ? "#d97706" : undefined;
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
        "group flex cursor-pointer items-center gap-2 border-b pr-3 text-sm",
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

export function CommitDetailPanel({ repoId, sha }: { repoId: number; sha: string }) {
  const detail = useCommitDetail(repoId, sha);
  const avatar = useCommitAvatar(repoId, sha, detail.data?.author_email ?? null);
  const [openFile, setOpenFile] = useState<FileChange | null>(null);

  if (!detail.data) {
    return <div className="p-4 text-sm text-[var(--color-muted-foreground)]">Loading…</div>;
  }
  const d = detail.data;

  return (
    <div className="flex h-full flex-col">
      <div className="max-h-[50%] shrink-0 overflow-auto border-b p-4">
        <Markdown>{d.message.trim()}</Markdown>
        <div className="mt-3 flex items-center gap-2">
          {/* A local commit carries only name + email, so the GitHub avatar is
              resolved (and cached) separately; until it loads — or when the
              repo isn't on GitHub / the email maps to no account — the Avatar's
              initials fallback renders. */}
          <Avatar src={avatar.data} name={d.author_name} size={20} />
          <p className="min-w-0 text-xs">
            <span className="font-medium text-[var(--color-foreground)]">{d.author_name}</span>
            <span className="text-[var(--color-muted-foreground)]">
              {" "}
              &lt;{d.author_email}&gt; · {formatDate(d.timestamp)}
            </span>
          </p>
        </div>
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
        <FileTree files={d.files} onOpen={setOpenFile} />
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
  const statuses = useRepoStatuses();
  const [limit, setLimit] = useState(PAGE);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // The ref whose history is being viewed — null means the checked-out HEAD.
  // This is a read-only "peek"; it never checks anything out (#254).
  const [viewRef, setViewRef] = useState<string | null>(null);
  const listRef = useRef<VListHandle>(null);
  const historySha = useUiStore((s) => s.historySha);
  const setHistorySha = useUiStore((s) => s.setHistorySha);

  const logQuery = useLog(repoId, limit, viewRef);
  const repo = repos.data?.find((r) => r.id === repoId);
  const currentBranch = statuses.data?.find((s) => s.id === repoId)?.branch ?? null;
  // Peeking at a ref other than what's checked out — drives the read-only badge.
  const peeking = viewRef !== null && viewRef !== currentBranch;

  // Reset per-repo view state when the active repo changes — the component stays
  // mounted across repo switches, so a selection/limit/filter/ref-peek from one
  // repo would otherwise leak into the next.
  useEffect(() => {
    setSelectedSha(null);
    setLimit(PAGE);
    setQuery("");
    setViewRef(null);
  }, [repoId]);

  // Reveal a commit requested from elsewhere (e.g. a PR's commit list): drop any
  // ref-peek back to HEAD (the target commit may not be on the peeked ref),
  // select it, clear any active filter, scroll it into view, then clear the
  // signal.
  useEffect(() => {
    if (!historySha) return;
    setViewRef(null);
    setSelectedSha(historySha);
    setQuery("");
    // Only clear the signal once the commit is actually found and scrolled into
    // view. Dropping the peek above triggers a HEAD refetch, so on the first run
    // logQuery.data may still be the peeked ref's commits (which need not contain
    // the target). Keeping historySha set lets this effect re-run when the HEAD
    // history arrives and finish the scroll then.
    const idx = (logQuery.data?.commits ?? []).findIndex((c) => c.sha === historySha);
    if (idx >= 0) {
      listRef.current?.scrollToIndex(idx, { align: "center" });
      setHistorySha(null);
    }
  }, [historySha, logQuery.data, setHistorySha]);

  // Drop the selection (and its detail pane) once the loaded log no longer holds
  // it — e.g. after an in-app branch switch lands a different history that omits
  // the previously-selected commit. Without this the right pane keeps showing a
  // commit absent on the new branch (#106). Guard on a settled, non-empty fetch
  // so we don't clear during the in-flight refetch between branches.
  useEffect(() => {
    if (!selectedSha || logQuery.isFetching) return;
    const commits = logQuery.data?.commits;
    if (!commits?.length) return;
    if (!commits.some((c) => c.sha === selectedSha)) setSelectedSha(null);
  }, [selectedSha, logQuery.data, logQuery.isFetching]);

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
        <RefPicker
          repoId={repoId}
          currentBranch={currentBranch}
          value={viewRef}
          onChange={setViewRef}
        />
        {peeking && (
          <span
            title="Viewing another ref's history — nothing is checked out"
            className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-accent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-muted-foreground)]"
          >
            <Eye className="size-3" />
            read-only
          </span>
        )}
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
                ref={listRef}
                style={{ height: "100%" }}
                count={commits.length + (showLoadMore ? 1 : 0)}
              >
                {(i) => {
                  // "Load more" is the last row, so it appears only at the bottom.
                  if (i >= commits.length) {
                    return (
                      <div key="load-more" className="flex justify-center border-t p-2">
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
