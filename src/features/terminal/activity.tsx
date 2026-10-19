import { cn } from "@/lib/utils";
import { ACTIVITY_PRIORITY, type TermActivityKind, type TermTab } from "@/store/ui";

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

/**
 * A session's status dot: a bell/exit colour when one is pending, a pulsing
 * dot while any pane is working, else a static dot (primary for unseen output).
 */
export function sessionDot(
  activity: TermActivityKind | undefined,
  busy: boolean,
): { color: string; pulse: boolean } {
  if (activity === "bell" || activity === "exit") {
    return { color: activityColor(activity), pulse: false };
  }
  if (busy) return { color: "var(--color-primary)", pulse: true };
  return { color: activity ? activityColor(activity) : "var(--color-faint)", pulse: false };
}

/** True when any of the tab's panes is producing output right now. */
export function tabBusy(tab: TermTab, termBusy: Record<string, true>): boolean {
  return tab.panes.some((p) => p.id in termBusy);
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
 * The most salient unseen-activity kind across a set of tabs' panes, if any —
 * a group's tabs for the Groups list dot, or every tab for an app-wide badge.
 *
 * `output` is deliberately excluded here (issue #124): a plain PTY-output dot
 * fires constantly while a session is just working, so on the group icon it's
 * noise rather than signal. Only `bell` (attention required) and `exit` light
 * up the dot. `output` still surfaces at the tab level via `tabActivityKind`,
 * where it usefully points at the busy tab.
 */
export function tabsActivityKind(
  tabs: TermTab[],
  termActivity: Record<string, TermActivityKind>,
): TermActivityKind | undefined {
  let best: TermActivityKind | undefined;
  for (const tab of tabs) {
    const k = tabActivityKind(tab, termActivity);
    if (k === "output") continue;
    if (k && (!best || ACTIVITY_PRIORITY[k] > ACTIVITY_PRIORITY[best])) best = k;
  }
  return best;
}
