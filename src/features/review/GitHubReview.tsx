import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ExternalLink,
  GitBranch,
  GitMerge,
  Github,
  GitPullRequestArrow,
  Link as LinkIcon,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { copy } from "@/lib/clipboard";
import { toast } from "@/store/toast";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Panel, PanelGroup, ResizeHandle } from "@/components/ui/resizable";
import type { MergeMethod, PrSummary, ReviewEvent } from "@/lib/ipc";
import { relativeTimeIso } from "@/lib/format";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/ui";
import { useDraftsFor, useReviewDrafts } from "@/store/reviewDrafts";
import {
  useCheckoutPr,
  useGithubAuth,
  useGithubPrs,
  useMentionables,
  useMergePr,
  usePrDetails,
  usePrThread,
  useSubmitReview,
} from "./api";
import { Conversation } from "./Conversation";
import { MergeStatusBlock, mergeVerdict } from "./MergeRequirements";
import { Avatar } from "./reviewShared";

function TokenGate() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <GitPullRequestArrow className="size-8 text-[var(--color-muted-foreground)]" />
      <p className="max-w-sm text-sm text-[var(--color-muted-foreground)]">
        Connect your GitHub account to review pull requests.
      </p>
      <p className="flex max-w-sm items-center justify-center gap-1.5 text-sm text-[var(--color-muted-foreground)]">
        Click the
        <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[var(--color-foreground)]">
          <Github className="size-3.5" /> GitHub
        </span>
        button at the bottom of the left sidebar to sign in.
      </p>
    </div>
  );
}

const REVIEW_OPTIONS: {
  event: ReviewEvent;
  label: string;
  description: string;
}[] = [
  {
    event: "COMMENT",
    label: "Comment",
    description: "Submit general feedback without explicit approval.",
  },
  {
    event: "APPROVE",
    label: "Approve",
    description: "Submit feedback and approve merging these changes.",
  },
  {
    event: "REQUEST_CHANGES",
    label: "Request changes",
    description: "Submit feedback suggesting changes.",
  },
];

export function ReviewPopover({
  repoId,
  number,
  headSha,
}: {
  repoId: number;
  number: number;
  headSha?: string;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const submit = useSubmitReview(repoId);
  const mentionables = useMentionables(repoId, open);
  const drafts = useDraftsFor(repoId, number);
  const clearDrafts = useReviewDrafts((s) => s.clear);

  // Approve needs no comment; otherwise require a body or pending inline drafts.
  const needsBody = event !== "APPROVE";
  const canSubmit =
    !submit.isPending && (!needsBody || body.trim().length > 0 || drafts.length > 0);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setBody("");
      setEvent("COMMENT");
      submit.reset();
    }
  }

  function send() {
    submit.mutate(
      {
        number,
        event,
        body,
        commitId: headSha,
        comments: drafts.length ? drafts : undefined,
      },
      {
        onSuccess: () => {
          clearDrafts(repoId, number);
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button size="sm">Submit review{drafts.length > 0 ? ` (${drafts.length})` : ""}</Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[30rem] space-y-3 p-3"
        // Don't steal focus from the editor's autofocus.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="text-sm font-semibold">Finish your review</div>

        {drafts.length > 0 && (
          <p className="text-xs text-[var(--color-muted-foreground)]">
            {drafts.length} pending inline comment
            {drafts.length === 1 ? "" : "s"} will be included.
          </p>
        )}

        <MarkdownEditor
          value={body}
          onChange={setBody}
          autoFocus
          mentions={mentionables.data ?? []}
        />

        <div className="space-y-2">
          {REVIEW_OPTIONS.map((opt) => (
            <label key={opt.event} className="flex cursor-pointer items-start gap-2.5">
              <input
                type="radio"
                name="review-event"
                className="mt-0.5"
                checked={event === opt.event}
                onChange={() => setEvent(opt.event)}
              />
              <div className="flex flex-col">
                <span className="text-sm font-medium leading-tight">{opt.label}</span>
                <span className="text-xs text-[var(--color-muted-foreground)]">
                  {opt.description}
                </span>
              </div>
            </label>
          ))}
        </div>

        {submit.isError && (
          <p className="text-xs text-[var(--color-destructive)]">{String(submit.error)}</p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={send} disabled={!canSubmit}>
            {submit.isPending && <Loader2 className="animate-spin" />}
            Submit review
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const MERGE_METHODS: { method: MergeMethod; label: string }[] = [
  { method: "merge", label: "Create a merge commit" },
  { method: "squash", label: "Squash and merge" },
  { method: "rebase", label: "Rebase and merge" },
];

function MergeBar({
  repoId,
  number,
  state,
  baseRef,
  headRef,
}: {
  repoId: number;
  number: number;
  state: string;
  baseRef?: string;
  headRef?: string;
}) {
  const merge = useMergePr(repoId);
  const details = usePrDetails(repoId, number);
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<MergeMethod>(useSettings.getState().values.mergeStrategy);

  if (state === "merged") {
    return (
      <div className="shrink-0 border-t px-3 py-2 text-sm font-medium text-[#8957e5]">
        This pull request has been merged.
      </div>
    );
  }
  if (state === "closed") {
    return (
      <div className="shrink-0 border-t px-3 py-2 text-sm text-[var(--color-muted-foreground)]">
        This pull request is closed.
      </div>
    );
  }

  const mergeInfo = details.data?.merge;
  const verdict = mergeVerdict(mergeInfo);
  const blocked = !verdict.canMerge;

  return (
    <div className="shrink-0">
      {mergeInfo && <MergeStatusBlock merge={mergeInfo} />}
      <div className="flex items-center gap-2 border-t px-3 py-2">
        <Popover
          open={open}
          onOpenChange={(o) => {
            // Always allow closing; only suppress opening while blocked, so a
            // popover that's already open can still be dismissed if the PR
            // becomes blocked (e.g. via polling) while it's showing.
            if (o && blocked) return;
            setOpen(o);
          }}
        >
          <PopoverTrigger asChild>
            <Button size="sm" disabled={blocked} title={verdict.reason ?? undefined}>
              <GitMerge /> Merge pull request
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 space-y-3 p-3">
            <div className="text-sm font-semibold">Merge pull request</div>
            <div className="space-y-1.5">
              {MERGE_METHODS.map((m) => (
                <label key={m.method} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="merge-method"
                    checked={method === m.method}
                    onChange={() => setMethod(m.method)}
                  />
                  {m.label}
                </label>
              ))}
            </div>
            <Button
              size="sm"
              className="w-full"
              disabled={merge.isPending || blocked}
              onClick={() =>
                merge.mutate(
                  { number, method, baseRef, headRef },
                  {
                    onSuccess: () => {
                      setOpen(false);
                      toast.success("Pull request merged");
                    },
                  },
                )
              }
            >
              {merge.isPending && <Loader2 className="animate-spin" />}
              Confirm merge
            </Button>
          </PopoverContent>
        </Popover>
        <span className="text-xs text-[var(--color-muted-foreground)]">
          {blocked && verdict.reason ? verdict.reason : "Merges into the base branch on GitHub."}
        </span>
      </div>
    </div>
  );
}

/** Which slice of the PR list to show. */
type PrFilter = "all" | "needs-review";

/** Segmented control above the PR list: All | Needs my review (with a count). */
function PrFilterBar({
  filter,
  onChange,
  reviewCount,
  disabled,
}: {
  filter: PrFilter;
  onChange: (f: PrFilter) => void;
  reviewCount: number;
  disabled: boolean;
}) {
  const options: { value: PrFilter; label: string; badge?: number }[] = [
    { value: "all", label: "All" },
    { value: "needs-review", label: "Needs my review", badge: reviewCount },
  ];
  return (
    <div className="flex shrink-0 gap-1 border-b px-2 py-1.5">
      {options.map((opt) => {
        // The "needs my review" filter is meaningless when signed out; fall
        // back to All and disable the option rather than showing an empty list.
        const isDisabled = disabled && opt.value === "needs-review";
        const active = filter === opt.value;
        return (
          <button
            key={opt.value}
            disabled={isDisabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-[var(--color-accent)] text-[var(--color-foreground)]"
                : "text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]",
              isDisabled &&
                "cursor-not-allowed opacity-50 hover:text-[var(--color-muted-foreground)]",
            )}
          >
            {opt.label}
            {opt.badge != null && opt.badge > 0 && (
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] leading-4",
                  active
                    ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
                    : "bg-[var(--color-accent)] text-[var(--color-muted-foreground)]",
                )}
              >
                {opt.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function PrList({
  prs,
  selected,
  onSelect,
  emptyMessage = "No open pull requests.",
}: {
  prs: PrSummary[];
  selected: number | null;
  onSelect: (n: number) => void;
  emptyMessage?: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto py-1">
      {prs.map((pr) => (
        <button
          key={pr.number}
          onClick={() => onSelect(pr.number)}
          className={cn(
            "flex w-full flex-col gap-0.5 px-3 py-2 text-left",
            selected === pr.number ? "bg-[var(--color-accent)]" : "hover:bg-[var(--color-accent)]",
          )}
        >
          <div className="flex items-center gap-2 text-sm">
            <span className="text-[var(--color-muted-foreground)]">#{pr.number}</span>
            <span className="min-w-0 flex-1 truncate font-medium">{pr.title}</span>
            {pr.draft && (
              <span className="shrink-0 rounded border px-1 text-[10px] text-[var(--color-muted-foreground)]">
                draft
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted-foreground)]">
            <Avatar src={pr.author_avatar} name={pr.author} size={16} />
            {pr.author} · {pr.base_ref} ← {pr.head_ref} · {relativeTimeIso(pr.updated_at)}
          </div>
        </button>
      ))}
      {prs.length === 0 && (
        <p className="px-3 py-6 text-center text-sm text-[var(--color-muted-foreground)]">
          {emptyMessage}
        </p>
      )}
    </div>
  );
}

export function GitHubReview({ repoId }: { repoId: number }) {
  const auth = useGithubAuth();
  const selected = useUiStore((s) => s.selectedPrNumber);
  const setSelected = useUiStore((s) => s.setSelectedPr);
  const prs = useGithubPrs(repoId, auth.data?.logged_in ?? false);
  const thread = usePrThread(repoId, selected);
  const checkout = useCheckoutPr(repoId);
  const selectedPr = prs.data?.find((p) => p.number === selected) ?? null;
  const setView = useUiStore((s) => s.setView);
  const setReviewMode = useUiStore((s) => s.setReviewMode);
  const qc = useQueryClient();
  const [filter, setFilter] = useState<PrFilter>("all");

  // PRs requesting the current user's review (pending or re-requested), with
  // their own PRs excluded. `requested_reviewers` already drops reviewers who've
  // submitted, so it captures exactly the PRs waiting on this user.
  const login = auth.data?.login ?? null;
  const allPrs = prs.data ?? [];
  const needsReview = useMemo(
    () =>
      login == null
        ? []
        : allPrs.filter((p) => p.author !== login && p.requested_reviewers.includes(login)),
    [allPrs, login],
  );
  // Guard against a stale "needs-review" selection when signing out.
  const activeFilter = login == null ? "all" : filter;
  const visiblePrs = activeFilter === "needs-review" ? needsReview : allPrs;

  // Pull fresh data for the open PR (new comments, reviews, commits, …).
  function refresh() {
    qc.invalidateQueries({ queryKey: ["github-prs", repoId] });
    if (selected == null) return;
    for (const k of [
      "github-pr-thread",
      "github-pr-timeline",
      "github-review-threads",
      "github-pr-details",
      "github-pr-diff",
    ]) {
      qc.invalidateQueries({ queryKey: [k, repoId, selected] });
    }
  }

  if (auth.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="animate-spin text-[var(--color-muted-foreground)]" />
      </div>
    );
  }

  if (!auth.data?.logged_in) {
    return <TokenGate />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelGroup
        direction="horizontal"
        autoSaveId="gamut.layout.review-github"
        className="flex min-h-0 flex-1"
      >
        <Panel defaultSize={30} minSize={18} maxSize={55} className="flex min-w-0 flex-col">
          {prs.isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="animate-spin text-[var(--color-muted-foreground)]" />
            </div>
          ) : prs.isError ? (
            <p className="p-3 text-sm text-[var(--color-destructive)]">{String(prs.error)}</p>
          ) : (
            <>
              <PrFilterBar
                filter={activeFilter}
                onChange={setFilter}
                reviewCount={needsReview.length}
                disabled={login == null}
              />
              <PrList
                prs={visiblePrs}
                selected={selected}
                onSelect={setSelected}
                emptyMessage={
                  activeFilter === "needs-review"
                    ? "No PRs waiting on your review."
                    : "No open pull requests."
                }
              />
            </>
          )}
        </Panel>

        <ResizeHandle />

        <Panel className="flex min-w-0 flex-col">
          {selected == null ? (
            <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-muted-foreground)]">
              Select a pull request to review.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {selectedPr?.title}{" "}
                    <span className="text-[var(--color-muted-foreground)]">#{selected}</span>
                  </div>
                  {selectedPr && (
                    <div className="truncate text-xs text-[var(--color-muted-foreground)]">
                      {selectedPr.base_ref} ← {selectedPr.head_ref}
                    </div>
                  )}
                </div>
                <Button
                  size="icon"
                  variant="outline"
                  className="size-8"
                  title="Refresh"
                  disabled={thread.isFetching}
                  onClick={refresh}
                >
                  <RefreshCw className={cn(thread.isFetching && "animate-spin")} />
                </Button>
                {selectedPr && (
                  <div className="flex items-center">
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-r-none"
                      title="Copy link to this pull request"
                      onClick={() => copy(selectedPr.url, "PR link copied")}
                    >
                      <LinkIcon />
                      Copy link
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-l-none border-l-0 px-2"
                      title="Open this pull request in your browser"
                      onClick={() => openUrl(selectedPr.url).catch(() => {})}
                    >
                      <ExternalLink />
                    </Button>
                  </div>
                )}
                {selectedPr && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={checkout.isPending}
                    title="Check out this PR's branch"
                    onClick={() =>
                      checkout.mutate(
                        {
                          number: selectedPr.number,
                          headRef: selectedPr.head_ref,
                        },
                        {
                          onSuccess: () => {
                            setReviewMode("branch");
                            setView("review");
                          },
                        },
                      )
                    }
                  >
                    {checkout.isPending ? <Loader2 className="animate-spin" /> : <GitBranch />}
                    Checkout
                  </Button>
                )}
                <ReviewPopover repoId={repoId} number={selected} headSha={selectedPr?.head_sha} />
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                {thread.isLoading || thread.data == null ? (
                  <div className="flex h-full items-center justify-center">
                    <Loader2 className="animate-spin text-[var(--color-muted-foreground)]" />
                  </div>
                ) : (
                  <div className="h-full overflow-auto">
                    <Conversation
                      thread={thread.data}
                      repoId={repoId}
                      number={selected}
                      prUrl={selectedPr?.url}
                      headRef={selectedPr?.head_ref}
                    />
                  </div>
                )}
              </div>
              {thread.data && (
                <MergeBar
                  repoId={repoId}
                  number={selected}
                  state={thread.data.state}
                  baseRef={selectedPr?.base_ref}
                  headRef={selectedPr?.head_ref}
                />
              )}
            </>
          )}
        </Panel>
      </PanelGroup>
    </div>
  );
}
