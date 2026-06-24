// Shared presentational helpers for the GitHub review UI, extracted from the
// former monolithic GitHubReview.tsx (#143). These are small, mostly stateless
// pieces used across the PR conversation, details, and timeline cards.
import {
  CheckCircle2,
  CircleSlash,
  Check,
  FileDiff,
  MessageSquare,
  Link as LinkIcon,
  type LucideIcon,
} from "lucide-react";

import { Markdown } from "@/components/Markdown";
import { copy } from "@/lib/clipboard";
import { relativeTimeIso } from "@/lib/format";
import type { PrComment, ThreadComment } from "@/lib/ipc";
import { cn } from "@/lib/utils";

export function reviewBadge(state: string | null): {
  label: string;
  color: string;
  Icon: LucideIcon;
} {
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
export function Avatar({
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

export function CopyLinkButton({
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
export function commentUrl(prUrl: string, comment: PrComment) {
  // Inline review comments carry their own permalink (#discussion_r…).
  if (comment.html_url) return comment.html_url;
  const frag =
    comment.kind === "review" ? `pullrequestreview-${comment.id}` : `issuecomment-${comment.id}`;
  return `${prUrl}#${frag}`;
}

/** Keep the last `n` lines of a diff hunk (the context around the comment). */
export function lastLines(text: string, n: number) {
  const lines = text.split("\n");
  return lines.length <= n ? text : lines.slice(-n).join("\n");
}

export function ReviewerStatusIcon({ state }: { state: string }) {
  switch (state) {
    case "APPROVED":
      return <Check className="size-4 text-[#16a34a]" />;
    case "CHANGES_REQUESTED":
      return <FileDiff className="size-4 text-[#dc2626]" />;
    case "COMMENTED":
      return <MessageSquare className="size-4 text-[var(--color-muted-foreground)]" />;
    case "DISMISSED":
      return <CircleSlash className="size-4 text-[var(--color-muted-foreground)]" />;
    default:
      return <span className="size-2.5 rounded-full bg-[#d4a72c]" />;
  }
}

/** Black or white text for readable contrast on a label's hex background. */
export function labelTextColor(hex: string) {
  const c = /^[0-9a-fA-F]{6}$/.test(hex) ? hex : "888888";
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#000" : "#fff";
}

/** Join names the way GitHub does: "a", "a and b", "a, b, and c". */
export function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function CommentCard({
  comment,
  prUrl,
  issueBaseUrl,
  onToggleTask,
}: {
  comment: PrComment;
  prUrl?: string;
  issueBaseUrl?: string;
  onToggleTask: (index: number, checked: boolean) => void;
}) {
  const badge = comment.kind === "review" ? reviewBadge(comment.state) : null;
  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 border-b bg-[var(--color-sidebar)] px-3 py-1.5 text-xs">
        <Avatar src={comment.author_avatar} name={comment.author} />
        <span className="font-medium">{comment.author}</span>
        {badge && (
          <span title={badge.label} style={{ color: badge.color }} className="flex items-center">
            <badge.Icon className="size-4" />
          </span>
        )}
        <span className="text-[var(--color-muted-foreground)]">
          {relativeTimeIso(comment.created_at)}
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
          <Markdown onToggleTask={onToggleTask} issueBaseUrl={issueBaseUrl}>
            {comment.body}
          </Markdown>
        </div>
      )}
    </div>
  );
}

export function ThreadCommentRow({
  comment,
  issueBaseUrl,
}: {
  comment: ThreadComment;
  issueBaseUrl?: string;
}) {
  return (
    <div className="px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-xs">
        <Avatar src={comment.author_avatar} name={comment.author} size={16} />
        <span className="font-medium">{comment.author}</span>
        <span className="text-[var(--color-muted-foreground)]">
          {relativeTimeIso(comment.created_at)}
        </span>
        {comment.url && (
          <CopyLinkButton url={comment.url} label="Copy link to this comment" className="ml-auto" />
        )}
      </div>
      <Markdown issueBaseUrl={issueBaseUrl}>{comment.body}</Markdown>
    </div>
  );
}
