import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Loader2 } from "lucide-react";

import { MarkdownEditor } from "@/components/MarkdownEditor";
import { Button } from "@/components/ui/button";
import type { ReviewThread } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useMentionables, useReplyReviewComment, useResolveThread } from "./api";
import { lastLines, ThreadCommentRow } from "./reviewShared";

export function ReviewThreadCard({
  thread,
  repoId,
  number,
  issueBaseUrl,
}: {
  thread: ReviewThread;
  repoId: number;
  number: number;
  issueBaseUrl?: string;
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
          <span className="shrink-0 rounded border px-1 text-[10px] text-[#a16207]">Outdated</span>
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
              <ThreadCommentRow key={c.id ?? i} comment={c} issueBaseUrl={issueBaseUrl} />
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
                  onClick={() => {
                    const next = !thread.is_resolved;
                    resolve.mutate(
                      { threadId: thread.id, resolved: next },
                      // Collapse once resolved, expand again on unresolve.
                      { onSuccess: () => setOpen(!next) },
                    );
                  }}
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
