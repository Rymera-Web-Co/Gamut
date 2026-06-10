import { useState } from "react";
import {
  GitBranch,
  Github,
  GitPullRequestArrow,
  Loader2,
} from "lucide-react";
import { Markdown, toggleTaskInMarkdown } from "@/components/Markdown";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Panel, PanelGroup, ResizeHandle } from "@/components/ui/resizable";
import type { PrComment, PrSummary, PrThread, ReviewEvent } from "@/lib/ipc";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/ui";
import { useDraftsFor, useReviewDrafts } from "@/store/reviewDrafts";
import {
  useCheckoutPr,
  useGithubAuth,
  useGithubPrs,
  useMentionables,
  usePrThread,
  useSubmitReview,
  useUpdateBody,
} from "./api";

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

function reviewBadge(state: string | null) {
  switch (state) {
    case "APPROVED":
      return { label: "approved", color: "#16a34a" };
    case "CHANGES_REQUESTED":
      return { label: "requested changes", color: "#dc2626" };
    case "DISMISSED":
      return { label: "dismissed", color: "#a16207" };
    default:
      return { label: "reviewed", color: "var(--color-muted-foreground)" };
  }
}

function CommentCard({
  comment,
  onToggleTask,
}: {
  comment: PrComment;
  onToggleTask: (index: number, checked: boolean) => void;
}) {
  const badge = comment.kind === "review" ? reviewBadge(comment.state) : null;
  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 border-b bg-[var(--color-sidebar)] px-3 py-1.5 text-xs">
        <span className="font-medium">{comment.author}</span>
        {badge && (
          <span style={{ color: badge.color }} className="font-medium">
            {badge.label}
          </span>
        )}
        <span className="text-[var(--color-muted-foreground)]">
          {comment.created_at
            ? relativeTime(Date.parse(comment.created_at) / 1000)
            : ""}
        </span>
      </div>
      {comment.body && (
        <div className="px-3 py-2">
          <Markdown onToggleTask={onToggleTask}>{comment.body}</Markdown>
        </div>
      )}
    </div>
  );
}

function Conversation({
  thread,
  repoId,
  number,
}: {
  thread: PrThread;
  repoId: number;
  number: number;
}) {
  const update = useUpdateBody(repoId);

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Description */}
      <div className="rounded-md border">
        <div className="flex items-center gap-2 border-b bg-[var(--color-sidebar)] px-3 py-1.5 text-xs">
          <span className="font-medium">{thread.author}</span>
          <span className="text-[var(--color-muted-foreground)]">
            opened this pull request
            {thread.created_at
              ? ` · ${relativeTime(Date.parse(thread.created_at) / 1000)}`
              : ""}
          </span>
        </div>
        <div className="px-3 py-2">
          <Markdown
            onToggleTask={(index) =>
              update.mutate({
                number,
                target: "pr",
                id: null,
                body: toggleTaskInMarkdown(thread.body, index),
              })
            }
          >
            {thread.body}
          </Markdown>
        </div>
      </div>

      {thread.comments.map((c) => (
        <CommentCard
          key={c.id}
          comment={c}
          onToggleTask={(index) =>
            update.mutate({
              number,
              target: c.kind === "review" ? "review" : "comment",
              id: c.id,
              body: toggleTaskInMarkdown(c.body, index),
            })
          }
        />
      ))}

      {thread.comments.length === 0 && (
        <p className="py-2 text-center text-xs text-[var(--color-muted-foreground)]">
          No comments yet.
        </p>
      )}
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
    !submit.isPending &&
    (!needsBody || body.trim().length > 0 || drafts.length > 0);

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
        <Button size="sm">
          Submit review{drafts.length > 0 ? ` (${drafts.length})` : ""}
        </Button>
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
            <label
              key={opt.event}
              className="flex cursor-pointer items-start gap-2.5"
            >
              <input
                type="radio"
                name="review-event"
                className="mt-0.5"
                checked={event === opt.event}
                onChange={() => setEvent(opt.event)}
              />
              <div className="flex flex-col">
                <span className="text-sm font-medium leading-tight">
                  {opt.label}
                </span>
                <span className="text-xs text-[var(--color-muted-foreground)]">
                  {opt.description}
                </span>
              </div>
            </label>
          ))}
        </div>

        {submit.isError && (
          <p className="text-xs text-[var(--color-destructive)]">
            {String(submit.error)}
          </p>
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

function PrList({
  prs,
  selected,
  onSelect,
}: {
  prs: PrSummary[];
  selected: number | null;
  onSelect: (n: number) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto py-1">
      {prs.map((pr) => (
        <button
          key={pr.number}
          onClick={() => onSelect(pr.number)}
          className={cn(
            "flex w-full flex-col gap-0.5 px-3 py-2 text-left",
            selected === pr.number
              ? "bg-[var(--color-accent)]"
              : "hover:bg-[var(--color-accent)]",
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
          <div className="text-xs text-[var(--color-muted-foreground)]">
            {pr.author} · {pr.base_ref} ← {pr.head_ref} · {relativeTime(
              Date.parse(pr.updated_at) / 1000,
            )}
          </div>
        </button>
      ))}
      {prs.length === 0 && (
        <p className="px-3 py-6 text-center text-sm text-[var(--color-muted-foreground)]">
          No open pull requests.
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
            <p className="p-3 text-sm text-[var(--color-destructive)]">
              {String(prs.error)}
            </p>
          ) : (
            <PrList
              prs={prs.data ?? []}
              selected={selected}
              onSelect={setSelected}
            />
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
                    <span className="text-[var(--color-muted-foreground)]">
                      #{selected}
                    </span>
                  </div>
                  {selectedPr && (
                    <div className="truncate text-xs text-[var(--color-muted-foreground)]">
                      {selectedPr.base_ref} ← {selectedPr.head_ref}
                    </div>
                  )}
                </div>
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
                    {checkout.isPending ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <GitBranch />
                    )}
                    Checkout
                  </Button>
                )}
                <ReviewPopover
                  repoId={repoId}
                  number={selected}
                  headSha={selectedPr?.head_sha}
                />
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
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </Panel>
      </PanelGroup>
    </div>
  );
}
