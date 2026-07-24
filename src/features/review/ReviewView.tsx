import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitCompare, GitPullRequestArrow } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useUiStore, type ReviewMode } from "@/store/ui";
import { useGithubAuth, useGithubPrs, useReviewFiles } from "./api";
import { BaseBranchPicker } from "./BaseBranchPicker";
import { ReviewPopover } from "./GitHubReview";
import { LocalReview } from "./LocalReview";
import { WorkingTree } from "./WorkingTree";

const MODES: { mode: ReviewMode; label: string }[] = [
  { mode: "working", label: "Working tree" },
  { mode: "branch", label: "Branch vs base" },
];

export function ReviewView() {
  const repoId = useUiStore((s) => s.activeRepoId);
  const mode = useUiStore((s) => s.reviewMode);
  const setMode = useUiStore((s) => s.setReviewMode);
  const setView = useUiStore((s) => s.setView);
  const setSelectedPr = useUiStore((s) => s.setSelectedPr);
  const persistedMode = useSettings((s) => s.values.reviewMode);
  const setSetting = useSettings((s) => s.set);

  // Apply the persisted default review mode when the tab first mounts. The
  // auto-pick below can still override it per repo (without persisting).
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (initialized) return;
    setMode(persistedMode);
    setInitialized(true);
  }, [initialized, persistedMode, setMode]);

  // A user's explicit choice becomes the new persisted default.
  const chooseMode = (m: ReviewMode) => {
    setMode(m);
    setSetting("reviewMode", m);
  };

  const auth = useGithubAuth();
  const prs = useGithubPrs(repoId, auth.data?.logged_in ?? false);
  const branches = useQuery({
    queryKey: ["branches", repoId],
    queryFn: () => ipc.listBranches(repoId!),
    enabled: repoId != null,
  });

  const currentBranch = branches.data?.find((b) => b.is_head)?.name;

  // The branch the review diffs against. `null` = Auto: the matched PR's base
  // (below), else the backend's default precedence (trunk/main/master). A user's
  // explicit pick in the base picker overrides both (#281, subtask st_761).
  const [baseOverride, setBaseOverride] = useState<string | null>(null);
  // Reset the override when the repo or checked-out branch changes — a base
  // pick is specific to the branch it was made against, so a new branch (whose
  // Auto base may differ) should start from Auto rather than inherit the pick.
  useEffect(() => {
    setBaseOverride(null);
  }, [repoId, currentBranch]);

  const matchingPr =
    currentBranch != null ? prs.data?.find((p) => p.head_ref === currentBranch) : undefined;
  // Auto base = the matched PR's base branch (the #281 fix); the picker override
  // wins when set. Undefined lets the backend fall back to default precedence.
  const effectiveBase = baseOverride ?? matchingPr?.base_ref ?? undefined;

  // Peek at both sources so we can auto-pick the one with changes. The working
  // peek shares the LocalReview cache directly; the branch peek uses the same
  // base as the review so their caches stay coherent (one extra branch fetch
  // happens only when a matched PR's base arrives and changes the base).
  const working = useReviewFiles(repoId, "working");
  const branchDiff = useReviewFiles(repoId, "branch", effectiveBase);

  // Once per repo: if the working tree is clean but the branch has changes,
  // default to "Branch vs base" — saves a click. Doesn't override the user
  // afterwards (decided per repo).
  const [decidedFor, setDecidedFor] = useState<number | null>(null);
  useEffect(() => {
    if (repoId == null || decidedFor === repoId) return;
    if (!working.data || !branchDiff.data) return;
    if (working.data.files.length === 0 && branchDiff.data.files.length > 0) {
      setMode("branch");
    }
    setDecidedFor(repoId);
  }, [repoId, working.data, branchDiff.data, decidedFor, setMode]);

  if (repoId == null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <GitCompare className="size-8 text-[var(--color-muted-foreground)]" />
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Select a repository from the left to review local changes.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
        {MODES.map(({ mode: m, label }) => (
          <button
            key={m}
            onClick={() => chooseMode(m)}
            className={cn(
              "rounded-md px-3 py-1 text-sm transition-colors",
              mode === m
                ? "bg-[var(--color-secondary)] text-[var(--color-secondary-foreground)]"
                : "text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)]",
            )}
          >
            {label}
          </button>
        ))}

        {mode === "branch" && (
          <div className="ml-auto flex items-center gap-2">
            <BaseBranchPicker
              repoId={repoId}
              value={baseOverride}
              autoLabel={matchingPr?.base_ref}
              onChange={setBaseOverride}
            />
            {matchingPr && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  title={`Open pull request #${matchingPr.number}`}
                  onClick={() => {
                    setSelectedPr(matchingPr.number);
                    setView("pulls");
                  }}
                >
                  <GitPullRequestArrow />
                  View PR #{matchingPr.number}
                </Button>
                <ReviewPopover
                  repoId={repoId}
                  number={matchingPr.number}
                  headSha={matchingPr.head_sha}
                />
              </>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {mode === "working" ? (
          <WorkingTree key={`${repoId}-working`} repoId={repoId} />
        ) : (
          <LocalReview
            key={`${repoId}-${mode}`}
            repoId={repoId}
            source={mode}
            base={effectiveBase}
            pr={
              matchingPr ? { number: matchingPr.number, headSha: matchingPr.head_sha } : undefined
            }
          />
        )}
      </div>
    </div>
  );
}
