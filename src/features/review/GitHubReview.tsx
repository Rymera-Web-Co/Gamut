import { useState } from "react";
import {
  GitBranch,
  GitPullRequestArrow,
  Loader2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, PanelGroup, ResizeHandle } from "@/components/ui/resizable";
import type { PrComment, PrSummary, PrThread, ReviewEvent } from "@/lib/ipc";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/ui";
import {
  useCheckoutPr,
  useGithubAuth,
  useGithubPrs,
  usePrThread,
  useSetToken,
  useSubmitReview,
} from "./api";

function TokenGate() {
  const [token, setToken] = useState("");
  const setTokenMut = useSetToken();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <GitPullRequestArrow className="size-8 text-[var(--color-muted-foreground)]" />
      <p className="max-w-sm text-sm text-[var(--color-muted-foreground)]">
        Sign in with a GitHub personal-access token (with <code>repo</code> scope) to
        review pull requests. The token is stored in your OS keychain.
      </p>
      <div className="flex w-full max-w-sm gap-2">
        <Input
          type="password"
          placeholder="ghp_…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && token && setTokenMut.mutate(token)}
        />
        <Button
          onClick={() => setTokenMut.mutate(token)}
          disabled={!token || setTokenMut.isPending}
        >
          {setTokenMut.isPending && <Loader2 className="animate-spin" />}
          Sign in
        </Button>
      </div>
      {setTokenMut.isError && (
        <p className="text-xs text-[var(--color-destructive)]">
          {String(setTokenMut.error)}
        </p>
      )}
    </div>
  );
}

function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none break-words prose-pre:text-xs">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {children || "_No description provided._"}
      </ReactMarkdown>
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

function CommentCard({ comment }: { comment: PrComment }) {
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
          <Markdown>{comment.body}</Markdown>
        </div>
      )}
    </div>
  );
}

function Conversation({ thread }: { thread: PrThread }) {
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
          <Markdown>{thread.body}</Markdown>
        </div>
      </div>

      {thread.comments.map((c, i) => (
        <CommentCard key={i} comment={c} />
      ))}

      {thread.comments.length === 0 && (
        <p className="py-2 text-center text-xs text-[var(--color-muted-foreground)]">
          No comments yet.
        </p>
      )}
    </div>
  );
}

function ReviewBox({ repoId, number }: { repoId: number; number: number }) {
  const [body, setBody] = useState("");
  const submit = useSubmitReview(repoId);

  function send(event: ReviewEvent) {
    submit.mutate(
      { number, event, body },
      { onSuccess: () => setBody("") },
    );
  }

  return (
    <div className="space-y-2 border-t p-3">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Leave a review comment…"
        className="h-20 w-full resize-none rounded-md border border-[var(--color-input)] bg-transparent p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => send("APPROVE")} disabled={submit.isPending}>
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => send("COMMENT")}
          disabled={submit.isPending || !body}
        >
          Comment
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => send("REQUEST_CHANGES")}
          disabled={submit.isPending || !body}
          className="text-[var(--color-destructive)]"
        >
          Request changes
        </Button>
        {submit.isPending && (
          <Loader2 className="size-4 animate-spin text-[var(--color-muted-foreground)]" />
        )}
        {submit.isError && (
          <span className="text-xs text-[var(--color-destructive)]">
            {String(submit.error)}
          </span>
        )}
        {submit.isSuccess && (
          <span className="text-xs text-[#16a34a]">Review submitted.</span>
        )}
      </div>
    </div>
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
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                {thread.isLoading || thread.data == null ? (
                  <div className="flex h-full items-center justify-center">
                    <Loader2 className="animate-spin text-[var(--color-muted-foreground)]" />
                  </div>
                ) : (
                  <div className="h-full overflow-auto">
                    <Conversation thread={thread.data} />
                  </div>
                )}
              </div>
              <ReviewBox repoId={repoId} number={selected} />
            </>
          )}
        </Panel>
      </PanelGroup>
    </div>
  );
}
