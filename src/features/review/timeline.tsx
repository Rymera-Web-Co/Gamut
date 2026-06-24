import { type ReactElement } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CircleDot,
  Eye,
  EyeOff,
  GitBranch,
  GitMerge,
  GitPullRequestArrow,
  Pencil,
  Tag,
  Trash2,
  UserMinus,
  UserPlus,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { isoToMillis, relativeTimeIso } from "@/lib/format";
import type { TimelineEvent } from "@/lib/ipc";
import { Commits } from "./Commits";
import { Avatar, joinNames, labelTextColor } from "./reviewShared";

/** A single subtle timeline line (ready-for-review, label, cross-reference, …). */
export function TimelineEventRow({ event }: { event: TimelineEvent }) {
  const actor = event.actor ?? "someone";
  let Icon: LucideIcon = CircleDot;
  let body: ReactElement | string = "";

  switch (event.kind) {
    case "ready_for_review":
      Icon = Eye;
      body = "marked this pull request as ready for review";
      break;
    case "convert_to_draft":
      Icon = EyeOff;
      body = "marked this pull request as a draft";
      break;
    case "review_requested":
      Icon = event.added === false ? UserMinus : UserPlus;
      body =
        event.added === false ? (
          <>
            removed the review request for <b>{event.subject}</b>
          </>
        ) : (
          <>
            requested a review from <b>{event.subject}</b>
          </>
        );
      break;
    case "assigned":
      Icon = event.added === false ? UserMinus : UserPlus;
      body = (
        <>
          {event.added === false ? "unassigned" : "assigned"} <b>{event.subject}</b>
        </>
      );
      break;
    case "labeled":
      Icon = Tag;
      body = (
        <>
          {event.added === false ? "removed" : "added"} the{" "}
          <span
            style={{
              backgroundColor: `#${event.label_color ?? "888888"}`,
              color: labelTextColor(event.label_color ?? "888888"),
            }}
            className="rounded-full px-2 py-0.5 text-xs font-medium"
          >
            {event.label}
          </span>{" "}
          label
        </>
      );
      break;
    case "renamed":
      Icon = Pencil;
      body = (
        <>
          renamed this from “{event.rename_from}” to “{event.rename_to}”
        </>
      );
      break;
    case "cross_referenced":
      Icon = event.ref_is_pull ? GitPullRequestArrow : CircleDot;
      body = (
        <>
          mentioned this in{" "}
          <button
            onClick={() => event.ref_url && openUrl(event.ref_url).catch(() => {})}
            className="text-left font-medium text-[var(--color-foreground)] hover:underline"
          >
            #{event.ref_number} {event.ref_title}
          </button>
        </>
      );
      break;
    case "closed":
      Icon = XCircle;
      body = "closed this pull request";
      break;
    case "reopened":
      Icon = CircleDot;
      body = "reopened this pull request";
      break;
    case "merged":
      Icon = GitMerge;
      body = (
        <>
          merged commit <code className="font-mono">{event.short_sha}</code>
        </>
      );
      break;
    case "head_ref_force_pushed":
      Icon = GitBranch;
      body = "force-pushed the branch";
      break;
    case "head_ref_deleted":
      Icon = Trash2;
      body = "deleted the branch";
      break;
    default:
      return null;
  }

  return (
    <div className="flex items-center gap-2 px-1 text-xs text-[var(--color-muted-foreground)]">
      <Icon className="size-4 shrink-0" />
      {event.actor_avatar !== undefined && event.actor && (
        <Avatar src={event.actor_avatar} name={actor} size={16} />
      )}
      <span className="min-w-0">
        <span className="font-medium text-[var(--color-foreground)]">{actor}</span> {body}
      </span>
      {event.created_at && <span className="shrink-0">· {relativeTimeIso(event.created_at)}</span>}
    </div>
  );
}

/**
 * Collapse the raw timeline into render items: consecutive commits become one
 * commit list, and consecutive review requests by the same actor merge into a
 * single "requested a review from A and B" line.
 */
export function groupTimeline(
  events: TimelineEvent[],
  repoId: number,
  number: number,
  headRef?: string,
): { at: number; key: string; node: ReactElement }[] {
  const items: { at: number; key: string; node: ReactElement }[] = [];
  let i = 0;
  while (i < events.length) {
    const e = events[i];

    if (e.kind === "committed") {
      const run: TimelineEvent[] = [];
      while (i < events.length && events[i].kind === "committed") {
        run.push(events[i]);
        i++;
      }
      items.push({
        at: isoToMillis(run[run.length - 1].created_at),
        key: `commits-${run[0].sha}`,
        node: <Commits repoId={repoId} number={number} headRef={headRef} commits={run} />,
      });
      continue;
    }

    if (e.kind === "review_requested" && e.added !== false) {
      const run: TimelineEvent[] = [];
      while (
        i < events.length &&
        events[i].kind === "review_requested" &&
        events[i].added !== false &&
        events[i].actor === e.actor
      ) {
        run.push(events[i]);
        i++;
      }
      const names = run.map((r) => r.subject).filter(Boolean) as string[];
      items.push({
        at: isoToMillis(e.created_at),
        key: `review-req-${e.created_at}`,
        node: <TimelineEventRow event={{ ...e, subject: joinNames(names) }} />,
      });
      continue;
    }

    items.push({
      at: isoToMillis(e.created_at),
      key: `ev-${e.kind}-${e.created_at}-${i}`,
      node: <TimelineEventRow event={e} />,
    });
    i++;
  }
  return items;
}
