import { useMemo, type ReactElement } from "react";

import { Markdown, toggleTaskInMarkdown } from "@/components/Markdown";
import { isoToMillis, relativeTimeIso } from "@/lib/format";
import type { PrThread, ReviewThread } from "@/lib/ipc";
import { usePrTimeline, useReviewThreads, useUpdateBody } from "./api";
import { PrDetailsCard } from "./PrDetailsCard";
import { ReviewThreadCard } from "./ReviewThreadCard";
import { Avatar, CommentCard, CopyLinkButton } from "./reviewShared";
import { groupTimeline } from "./timeline";

export function Conversation({
  thread,
  repoId,
  number,
  prUrl,
  headRef,
}: {
  thread: PrThread;
  repoId: number;
  number: number;
  prUrl?: string;
  headRef?: string;
}) {
  const update = useUpdateBody(repoId);
  // Keep the raw query data (a stable reference) out of the memo deps; the `?? []`
  // fallback lives inside so an empty result doesn't mint a fresh array every
  // render and defeat the memo (#142).
  const threadsData = useReviewThreads(repoId, number).data;
  const timelineData = usePrTimeline(repoId, number).data;
  // e.g. ".../owner/repo/pull/22" -> ".../owner/repo/issues" for #N refs.
  const issueBaseUrl = prUrl ? prUrl.replace(/\/pull\/\d+.*$/, "/issues") : undefined;

  // Build the timeline once per data change instead of on every render (#142):
  // grouping comments/threads into a Set+Map and constructing the element array
  // is real work for a busy PR, and this component re-renders on every 30s
  // refetch, git-watch invalidation, and parent state change.
  const items = useMemo(() => {
    const threads = threadsData ?? [];
    const timeline = timelineData ?? [];
    // Group inline threads under the review they were submitted with; threads
    // with no matching review stand alone in the timeline.
    const reviewIds = new Set(thread.comments.filter((c) => c.kind === "review").map((c) => c.id));
    const threadsByReview = new Map<number, ReviewThread[]>();
    const orphanThreads: ReviewThread[] = [];
    for (const t of threads) {
      if (t.review_id != null && reviewIds.has(t.review_id)) {
        const arr = threadsByReview.get(t.review_id) ?? [];
        arr.push(t);
        threadsByReview.set(t.review_id, arr);
      } else {
        orphanThreads.push(t);
      }
    }

    const items: { at: number; key: string; node: ReactElement }[] = [];

    for (const c of thread.comments) {
      const childThreads = c.kind === "review" ? (threadsByReview.get(c.id) ?? []) : [];
      items.push({
        at: isoToMillis(c.created_at),
        key: `c${c.id}`,
        node: (
          <div className="flex flex-col gap-3">
            <CommentCard
              comment={c}
              prUrl={prUrl}
              issueBaseUrl={issueBaseUrl}
              onToggleTask={(index) =>
                update.mutate({
                  number,
                  target: c.kind === "review" ? "review" : "comment",
                  id: c.id,
                  body: toggleTaskInMarkdown(c.body, index),
                })
              }
            />
            {childThreads.length > 0 && (
              <div className="ml-4 flex flex-col gap-3 border-l-2 border-[var(--color-border)] pl-3">
                {childThreads.map((t) => (
                  <ReviewThreadCard
                    key={t.id}
                    thread={t}
                    repoId={repoId}
                    number={number}
                    issueBaseUrl={issueBaseUrl}
                  />
                ))}
              </div>
            )}
          </div>
        ),
      });
    }
    for (const t of orphanThreads) {
      items.push({
        at: isoToMillis(t.comments[0]?.created_at ?? ""),
        key: `t${t.id}`,
        node: (
          <ReviewThreadCard
            thread={t}
            repoId={repoId}
            number={number}
            issueBaseUrl={issueBaseUrl}
          />
        ),
      });
    }
    items.push(...groupTimeline(timeline, repoId, number, headRef));
    items.sort((a, b) => a.at - b.at);
    return items;
  }, [
    thread.comments,
    threadsData,
    timelineData,
    update,
    prUrl,
    issueBaseUrl,
    number,
    repoId,
    headRef,
  ]);

  return (
    <div className="flex flex-col gap-3 p-3">
      <PrDetailsCard repoId={repoId} number={number} />

      {/* Description */}
      <div className="rounded-md border">
        <div className="flex items-center gap-2 border-b bg-[var(--color-sidebar)] px-3 py-1.5 text-xs">
          <Avatar src={thread.author_avatar} name={thread.author} />
          <span className="font-medium">{thread.author}</span>
          <span className="text-[var(--color-muted-foreground)]">
            opened this pull request
            {thread.created_at ? ` · ${relativeTimeIso(thread.created_at)}` : ""}
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
            issueBaseUrl={issueBaseUrl}
            hardBreaks
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

      {items.map((i) => (
        <div key={i.key}>{i.node}</div>
      ))}

      {items.length === 0 && (
        <p className="py-2 text-center text-xs text-[var(--color-muted-foreground)]">
          No comments yet.
        </p>
      )}
    </div>
  );
}
