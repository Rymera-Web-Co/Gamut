import { cn } from "@/lib/utils";
import {
  ACTIVITY_PRIORITY,
  type GroupTerminals,
  type TermActivityKind,
  type TermTab,
} from "@/store/ui";

/** Activity badge colour, keyed off the most salient pending event. */
export function activityColor(kind: TermActivityKind): string {
  switch (kind) {
    case "exit":
      return "var(--color-destructive)";
    case "bell":
      return "#f59e0b";
    default:
      return "var(--color-primary)";
  }
}

/** Small "unseen activity" dot used on inactive tabs, splits and group rail. */
export function ActivityDot({ kind, className }: { kind: TermActivityKind; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-1.5 shrink-0 rounded-full", className)}
      style={{ background: activityColor(kind) }}
    />
  );
}

/** The most salient unseen-activity kind across a single tab's panes, if any. */
export function tabActivityKind(
  tab: TermTab,
  termActivity: Record<string, TermActivityKind>,
): TermActivityKind | undefined {
  let best: TermActivityKind | undefined;
  for (const p of tab.panes) {
    const k = termActivity[p.id];
    if (k && (!best || ACTIVITY_PRIORITY[k] > ACTIVITY_PRIORITY[best])) best = k;
  }
  return best;
}

/**
 * The most salient unseen-activity kind across a group's panes, if any.
 *
 * `output` is deliberately excluded here (issue #124): a plain PTY-output dot
 * fires constantly while a session is just working, so on the group icon it's
 * noise rather than signal. Only `bell` (attention required) and `exit` light
 * up the group dot. `output` still surfaces at the tab level via
 * `tabActivityKind`, where it usefully points at the busy tab.
 */
export function groupActivityKind(
  gt: GroupTerminals | undefined,
  termActivity: Record<string, TermActivityKind>,
): TermActivityKind | undefined {
  if (!gt) return undefined;
  let best: TermActivityKind | undefined;
  for (const tab of gt.tabs) {
    const k = tabActivityKind(tab, termActivity);
    if (k === "output") continue;
    if (k && (!best || ACTIVITY_PRIORITY[k] > ACTIVITY_PRIORITY[best])) best = k;
  }
  return best;
}
