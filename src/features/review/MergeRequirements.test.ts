import { describe, it, expect } from "vitest";
import type { MergeInfo } from "@/lib/ipc";
import { mergeVerdict } from "./MergeRequirements";

/** A clean, mergeable PR; override fields per case. */
function info(overrides: Partial<MergeInfo> = {}): MergeInfo {
  return {
    review_decision: "APPROVED",
    mergeable: "MERGEABLE",
    merge_state_status: "CLEAN",
    is_draft: false,
    check_rollup: "SUCCESS",
    checks: [],
    ...overrides,
  };
}

describe("mergeVerdict", () => {
  it("allows merging while details are still loading (no data)", () => {
    expect(mergeVerdict(undefined)).toEqual({ canMerge: true, reason: null, computing: false });
  });

  it("enables the button when the branch is clean", () => {
    expect(mergeVerdict(info()).canMerge).toBe(true);
  });

  it("treats UNSTABLE / HAS_HOOKS as mergeable (GitHub allows them)", () => {
    expect(mergeVerdict(info({ merge_state_status: "UNSTABLE" })).canMerge).toBe(true);
    expect(mergeVerdict(info({ merge_state_status: "HAS_HOOKS" })).canMerge).toBe(true);
  });

  it("blocks a draft PR", () => {
    const v = mergeVerdict(info({ is_draft: true, merge_state_status: "DRAFT" }));
    expect(v.canMerge).toBe(false);
    expect(v.reason).toMatch(/draft/i);
  });

  it("blocks when the branch conflicts with the base", () => {
    const v = mergeVerdict(info({ mergeable: "CONFLICTING", merge_state_status: "DIRTY" }));
    expect(v.canMerge).toBe(false);
    expect(v.reason).toMatch(/conflict/i);
  });

  it("blocks when changes are requested", () => {
    const v = mergeVerdict(
      info({ review_decision: "CHANGES_REQUESTED", merge_state_status: "BLOCKED" }),
    );
    expect(v.canMerge).toBe(false);
    expect(v.reason).toMatch(/changes were requested/i);
  });

  it("blocks when a required review is missing", () => {
    const v = mergeVerdict(
      info({ review_decision: "REVIEW_REQUIRED", merge_state_status: "BLOCKED" }),
    );
    expect(v.canMerge).toBe(false);
    expect(v.reason).toMatch(/required review/i);
  });

  it("blocks a branch that is behind its base", () => {
    const v = mergeVerdict(info({ merge_state_status: "BEHIND" }));
    expect(v.canMerge).toBe(false);
    expect(v.reason).toMatch(/out of date/i);
  });

  it("blocks on BLOCKED with a generic reason when no specific cause is known", () => {
    const v = mergeVerdict(info({ review_decision: null, merge_state_status: "BLOCKED" }));
    expect(v.canMerge).toBe(false);
    expect(v.reason).toMatch(/required checks or reviews/i);
  });

  it("treats UNKNOWN mergeability as still-computing, not a hard block", () => {
    const v = mergeVerdict(
      info({ mergeable: "UNKNOWN", merge_state_status: "UNKNOWN", check_rollup: null }),
    );
    expect(v.canMerge).toBe(false);
    expect(v.computing).toBe(true);
  });

  it("combines multiple blockers into one reason", () => {
    const v = mergeVerdict(
      info({
        mergeable: "CONFLICTING",
        merge_state_status: "DIRTY",
        review_decision: "CHANGES_REQUESTED",
      }),
    );
    expect(v.canMerge).toBe(false);
    expect(v.reason).toMatch(/conflicts/i);
    expect(v.reason).toMatch(/changes were requested/i);
  });
});
