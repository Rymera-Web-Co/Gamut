import { useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  FileDiff,
  GitBranch,
  Github,
  GitPullRequestArrow,
  Link as LinkIcon,
  Loader2,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import { Markdown, toggleTaskInMarkdown } from "@/components/Markdown";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { copy } from "@/lib/clipboard";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Panel, PanelGroup, ResizeHandle } from "@/components/ui/resizable";
import type {
  PrComment,
  PrSummary,
  PrThread,
  ReviewEvent,
  ReviewThread,
  ThreadComment,
} from "@/lib/ipc";
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
  useReplyReviewComment,
  useResolveThread,
  useReviewThreads,
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

function reviewBadge(
  state: string | null,
): { label: string; color: string; Icon: LucideIcon } {
  switch (state) {
    case "APPROVED":
      return { label: "approved", color: "#16a34a", Icon: CheckCircle2 };
    case "CHANGES_REQUESTED":
      return { label: "requested changes", color: "#dc2626", Icon: FileDiff };
    case "DISMISSED":
      return { label: "dismissed", color: "#a16207", Icon: CircleSlash };
    default:
      return {
        label: "reviewed",
        color: "var(--color-muted-foreground)",
        Icon: MessageSquare,
      };
  }
}

/** Small round user avatar with an initial fallback. */
function Avatar({
  src,
  name,
  size = 18,
}: {
  src?: string | null;
  name: string;
  size?: number;
}) {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        title={name}
        width={size}
        height={size}
        className="shrink-0 rounded-full"
      />
    );
  }
  return (
    <span
      title={name}
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] text-[10px] font-medium uppercase text-[var(--color-muted-foreground)]"
    >
      {name.slice(0, 1)}
    </span>
  );
}

function CopyLinkButton({
  url,
  label,
  className,
}: {
  url: string;
  label: string;
  className?: string;
}) {
  return (
    <button
      title={label}
      onClick={() => copy(url, "Link copied")}
      className={cn(
        "shrink-0 rounded p-0.5 text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]",
        className,
      )}
    >
      <LinkIcon className="size-3.5" />
    </button>
  );
}

/** Permalink to a specific comment/review within the PR. */
function commentUrl(prUrl: string, comment: PrComment) {
  // Inline review comments carry their own permalink (#discussion_r…).
  if (comment.html_url) return comment.html_url;
  const frag =
    comment.kind === "review"
      ? `pullrequestreview-${comment.id}`
      : `issuecomment-${comment.id}`;
  return `${prUrl}#${frag}`;
}

/** Keep the last `n` lines of a diff hunk (the context around the comment). */
function lastLines(text: string, n: number) {
  const lines = text.split("\n");
  return lines.length <= n ? text : lines.slice(-n).join("\n");
}

function CommentCard({
  comment,
  prUrl,
  onToggleTask,
}: {
  comment: PrComment;
  prUrl?: string;
  onToggleTask: (index: number, checked: boolean) => void;
}) {
  const badge = comment.kind === "review" ? reviewBadge(comment.state) : null;
  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 border-b bg-[var(--color-sidebar)] px-3 py-1.5 text-xs">
        <Avatar src={comment.author_avatar} name={comment.author} />
        <span className="font-medium">{comment.author}</span>
        {badge && (
          <span
            title={badge.label}
            style={{ color: badge.color }}
            className="flex items-center"
          >
            <badge.Icon className="size-4" />
          </span>
        )}
        <span className="text-[var(--color-muted-foreground)]">
          {comment.created_at
            ? relativeTime(Date.parse(comment.created_at) / 1000)
            : ""}
        </span>
        {prUrl && (
          <CopyLinkButton
            url={commentUrl(prUrl, comment)}
            label="Copy link to this comment"
            className="ml-auto"
          />
        )}
      </div>

      {comment.body && (
        <div className="px-3 py-2">
          <Markdown onToggleTask={onToggleTask}>{comment.body}</Markdown>
        </div>
      )}
    </div>
  );
}

function ThreadCommentRow({ comment }: { comment: ThreadComment }) {
  return (
    <div className="px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-xs">
        <Avatar src={comment.author_avatar} name={comment.author} size={16} />
        <span className="font-medium">{comment.author}</span>
        <span className="text-[var(--color-muted-foreground)]">
          {comment.created_at
            ? relativeTime(Date.parse(comment.created_at) / 1000)
            : ""}
        </span>
        {comment.url && (
          <CopyLinkButton
            url={comment.url}
            label="Copy link to this comment"
            className="ml-auto"
          />
        )}
      </div>
      <Markdown>{comment.body}</Markdown>
    </div>
  );
}

function ReviewThreadCard({
  thread,
  repoId,
  number,
}: {
  thread: ReviewThread;
  repoId: number;
  number: number;
}) {
  const reply = useReplyReviewComment(repoId);
  const resolve = useResolveThread(repoId, number);
  const mentionables = useMentionables(repoId, true);
  const [open, setOpen] = useState(!thread.is_resolved);
  const [replying, setReplying] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const rootId = thread.comments[0]?.id;

  function sendReply() {
    if (rootId == null || !replyBody.trim()) return;
    reply.mutate(
      { number, commentId: rootId, body: replyBody },
      {
        onSuccess: () => {
          setReplyBody("");
          setReplying(false);
        },
      },
    );
  }

  return (
    <div className={cn("rounded-md border", thread.is_resolved && "opacity-75")}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 border-b bg-[var(--color-sidebar)] px-3 py-1.5 text-xs"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 truncate font-mono text-[var(--color-muted-foreground)]">
          {thread.path}
          {thread.line != null ? `:${thread.line}` : ""}
        </span>
        {thread.is_outdated && (
          <span className="shrink-0 rounded border px-1 text-[10px] text-[#a16207]">
            Outdated
          </span>
        )}
        {thread.is_resolved && (
          <span className="flex shrink-0 items-center gap-1 rounded border px-1 text-[10px] text-[#16a34a]">
            <Check className="size-3" /> Resolved
          </span>
        )}
        <span className="ml-auto shrink-0 text-[var(--color-muted-foreground)]">
          {thread.comments.length}
        </span>
      </button>

      {open && (
        <>
          {thread.diff_hunk && (
            <pre className="max-h-40 overflow-auto border-b bg-[var(--color-sidebar)] p-2 text-[11px] leading-snug">
              <code>{lastLines(thread.diff_hunk, 6)}</code>
            </pre>
          )}

          <div className="divide-y">
            {thread.comments.map((c, i) => (
              <ThreadCommentRow key={c.id ?? i} comment={c} />
            ))}
          </div>

          <div className="space-y-2 border-t p-2">
            {replying ? (
              <>
                <MarkdownEditor
                  value={replyBody}
                  onChange={setReplyBody}
                  autoFocus
                  minHeight="min-h-20"
                  mentions={mentionables.data ?? []}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setReplying(false);
                      setReplyBody("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={!replyBody.trim() || reply.isPending || rootId == null}
                    onClick={sendReply}
                  >
                    {reply.isPending && <Loader2 className="animate-spin" />}
                    Reply
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setReplying(true)}
                  className="flex-1 rounded-md border border-[var(--color-input)] px-3 py-1.5 text-left text-sm text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)]"
                >
                  Reply…
                </button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={resolve.isPending}
                  onClick={() =>
                    resolve.mutate({
                      threadId: thread.id,
                      resolved: !thread.is_resolved,
                    })
                  }
                >
                  {resolve.isPending && <Loader2 className="animate-spin" />}
                  {thread.is_resolved ? "Unresolve" : "Resolve conversation"}
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ReviewThreads({ repoId, number }: { repoId: number; number: number }) {
  const threads = useReviewThreads(repoId, number);
  const list = threads.data ?? [];
  if (list.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
        Review comments
      </div>
      {list.map((t) => (
        <ReviewThreadCard key={t.id} thread={t} repoId={repoId} number={number} />
      ))}
    </div>
  );
}

function Conversation({
  thread,
  repoId,
  number,
  prUrl,
}: {
  thread: PrThread;
  repoId: number;
  number: number;
  prUrl?: string;
}) {
  const update = useUpdateBody(repoId);

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Description */}
      <div className="rounded-md border">
        <div className="flex items-center gap-2 border-b bg-[var(--color-sidebar)] px-3 py-1.5 text-xs">
          <Avatar src={thread.author_avatar} name={thread.author} />
          <span className="font-medium">{thread.author}</span>
          <span className="text-[var(--color-muted-foreground)]">
            opened this pull request
            {thread.created_at
              ? ` · ${relativeTime(Date.parse(thread.created_at) / 1000)}`
              : ""}
          </span>
          {prUrl && (
            <CopyLinkButton
              url={prUrl}
              label="Copy link to this pull request"
              className="ml-auto"
            />
          )}
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
          prUrl={prUrl}
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

      <ReviewThreads repoId={repoId} number={number} />

      {thread.comments.length === 0 && (
        <p className="py-2 text-center text-xs text-[var(--color-muted-foreground)]">
          No top-level comments yet.
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
          <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted-foreground)]">
            <Avatar src={pr.author_avatar} name={pr.author} size={16} />
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
                    title="Copy link to this pull request"
                    onClick={() => copy(selectedPr.url, "PR link copied")}
                  >
                    <LinkIcon />
                    Copy link
                  </Button>
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
                      prUrl={selectedPr?.url}
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
