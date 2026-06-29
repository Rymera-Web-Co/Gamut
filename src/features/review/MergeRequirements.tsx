// The merge-requirements status block shown above the merge button in the PR
// tab (#185): a compact checklist of CI checks, review decision, and the
// branch's mergeable state, plus the verdict that gates the merge button.
import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckCircle2, XCircle, AlertTriangle, Clock, type LucideIcon } from "lucide-react";

import type { MergeInfo } from "@/lib/ipc";
import { cn } from "@/lib/utils";

/** GitHub's mergeStateStatus values that mean the merge button stays usable.
 * UNSTABLE = mergeable but a non-required check is failing; HAS_HOOKS = mergeable
 * with pre-receive hooks. GitHub allows both, so we don't block on them. */
const MERGEABLE_STATES = new Set(["CLEAN", "UNSTABLE", "HAS_HOOKS"]);

export interface MergeVerdict {
  /** Whether the merge button should be enabled. */
  canMerge: boolean;
  /** Short reason shown when the button is disabled (null when enabled). */
  reason: string | null;
  /** GitHub is still computing mergeability (mergeable / mergeStateStatus UNKNOWN). */
  computing: boolean;
}

/** Join blocking reasons GitHub-style: "a", "a and b", "a, b, and c". */
function joinReasons(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/**
 * Decide whether the PR can be merged, mirroring GitHub's own verdict.
 * `mergeStateStatus` is authoritative when known: CLEAN/UNSTABLE/HAS_HOOKS are
 * mergeable, everything else is blocked. When it's UNKNOWN (right after a push)
 * we fall back to the signals we *do* know are blocking — conflicts, draft, a
 * requested-changes / review-required decision — and otherwise treat it as
 * still-computing rather than hard-blocking forever.
 */
export function mergeVerdict(m: MergeInfo | undefined): MergeVerdict {
  // No data yet (still loading): don't gate — preserve prior behavior.
  if (!m) return { canMerge: true, reason: null, computing: false };

  const mss = m.merge_state_status;
  const reasons: string[] = [];
  if (m.is_draft || mss === "DRAFT") reasons.push("it's a draft");
  if (m.mergeable === "CONFLICTING" || mss === "DIRTY")
    reasons.push("there are conflicts with the base branch");
  if (m.review_decision === "CHANGES_REQUESTED") reasons.push("changes were requested");
  if (m.review_decision === "REVIEW_REQUIRED") reasons.push("a required review is missing");
  if (mss === "BEHIND") reasons.push("the branch is out of date with the base");
  if (mss === "BLOCKED" && reasons.length === 0)
    reasons.push("required checks or reviews are not satisfied");

  // Authoritative mergeable state — enable the button.
  if (MERGEABLE_STATES.has(mss)) return { canMerge: true, reason: null, computing: false };

  // Known blocker(s) — disable with a reason.
  if (reasons.length > 0)
    return {
      canMerge: false,
      reason: `Merging is blocked: ${joinReasons(reasons)}`,
      computing: false,
    };

  // No specific blocker but GitHub hasn't finished computing — treat as not-yet.
  if (mss === "UNKNOWN" || mss === "" || m.mergeable === "UNKNOWN")
    return {
      canMerge: false,
      reason: "Checking whether this branch can be merged…",
      computing: true,
    };

  // Some other state with no known blocker: don't be stricter than GitHub.
  return { canMerge: true, reason: null, computing: false };
}

type RowTone = "success" | "failure" | "pending" | "warning";

const ROW_ICON: Record<RowTone, { Icon: LucideIcon; color: string }> = {
  success: { Icon: CheckCircle2, color: "#16a34a" },
  failure: { Icon: XCircle, color: "#dc2626" },
  warning: { Icon: AlertTriangle, color: "#d4a72c" },
  pending: { Icon: Clock, color: "var(--color-muted-foreground)" },
};

function Row({ tone, title, detail }: { tone: RowTone; title: string; detail?: string }) {
  const { Icon, color } = ROW_ICON[tone];
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 size-4 shrink-0" style={{ color }} />
      <div className="min-w-0">
        <div className="text-sm leading-tight">{title}</div>
        {detail && <div className="text-xs text-[var(--color-muted-foreground)]">{detail}</div>}
      </div>
    </div>
  );
}

/** Summarize the head-commit checks into a single row (counts + failing names). */
function checksRow(m: MergeInfo): { tone: RowTone; title: string; detail?: string } | null {
  const checks = m.checks ?? [];
  if (checks.length === 0 && !m.check_rollup) return null;

  const failing = checks.filter((c) => c.state === "FAILURE" || c.state === "ERROR");
  const pending = checks.filter((c) => c.state === "PENDING");
  const total = checks.length;

  if (m.check_rollup === "FAILURE" || m.check_rollup === "ERROR" || failing.length > 0) {
    const names = failing
      .map((c) => c.name)
      .slice(0, 4)
      .join(", ");
    return {
      tone: "failure",
      title: `${failing.length || 1} failing check${failing.length === 1 ? "" : "s"}`,
      detail: names || undefined,
    };
  }
  if (m.check_rollup === "PENDING" || m.check_rollup === "EXPECTED" || pending.length > 0) {
    return {
      tone: "pending",
      title: `${pending.length || 1} check${pending.length === 1 ? "" : "s"} still running`,
    };
  }
  return {
    tone: "success",
    title: "All checks have passed",
    detail: total > 0 ? `${total} successful check${total === 1 ? "" : "s"}` : undefined,
  };
}

/** The review-decision row, or null when the repo requires no review. */
function reviewRow(m: MergeInfo): { tone: RowTone; title: string } | null {
  switch (m.review_decision) {
    case "APPROVED":
      return { tone: "success", title: "Changes approved" };
    case "CHANGES_REQUESTED":
      return { tone: "warning", title: "Changes requested" };
    case "REVIEW_REQUIRED":
      return { tone: "warning", title: "Review required" };
    default:
      return null;
  }
}

/** The conflicts / branch-state row. */
function conflictRow(m: MergeInfo): { tone: RowTone; title: string } | null {
  if (m.mergeable === "CONFLICTING" || m.merge_state_status === "DIRTY")
    return { tone: "failure", title: "This branch has conflicts that must be resolved" };
  if (m.merge_state_status === "BEHIND")
    return { tone: "warning", title: "This branch is out of date with the base branch" };
  if (m.mergeable === "MERGEABLE")
    return { tone: "success", title: "This branch has no conflicts with the base branch" };
  return null;
}

/** Compact "ready / not ready" checklist mirroring GitHub's merge box. */
export function MergeStatusBlock({ merge }: { merge: MergeInfo }) {
  if (merge.is_draft || merge.merge_state_status === "DRAFT") {
    return (
      <div className="border-t px-3 py-2">
        <Row tone="warning" title="This pull request is still a draft" />
      </div>
    );
  }

  const checks = checksRow(merge);
  const review = reviewRow(merge);
  const conflict = conflictRow(merge);
  const computing = merge.mergeable === "UNKNOWN" || merge.merge_state_status === "UNKNOWN";

  return (
    <div className="space-y-1.5 border-t px-3 py-2">
      {checks && (
        <button
          type="button"
          disabled={(merge.checks ?? []).every((c) => !c.url)}
          onClick={() => {
            const url = (merge.checks ?? []).find((c) => c.url)?.url;
            if (url) openUrl(url).catch(() => {});
          }}
          className={cn(
            "block w-full text-left",
            (merge.checks ?? []).some((c) => c.url) && "hover:opacity-80",
          )}
        >
          <Row tone={checks.tone} title={checks.title} detail={checks.detail} />
        </button>
      )}
      {review && <Row tone={review.tone} title={review.title} />}
      {conflict && <Row tone={conflict.tone} title={conflict.title} />}
      {computing && !conflict && (
        <Row tone="pending" title="Checking whether this branch can be merged…" />
      )}
    </div>
  );
}
