import { cn } from "@/lib/utils";
import { ACTIVITY_PRIORITY, type GroupTerminals, type TermActivityKind } from "@/store/ui";

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
export function ActivityDot({
  kind,
  className,
}: {
  kind: TermActivityKind;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-1.5 shrink-0 rounded-full", className)}
      style={{ background: activityColor(kind) }}
    />
  );
}

/** The most salient unseen-activity kind across a group's panes, if any. */
export function groupActivityKind(
  gt: GroupTerminals | undefined,
  termActivity: Record<string, TermActivityKind>,
): TermActivityKind | undefined {
  if (!gt) return undefined;
  let best: TermActivityKind | undefined;
  for (const tab of gt.tabs) {
    for (const p of tab.panes) {
      const k = termActivity[p.id];
      if (k && (!best || ACTIVITY_PRIORITY[k] > ACTIVITY_PRIORITY[best])) best = k;
    }
  }
  return best;
}
