import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitCompare, GitPullRequestArrow } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useUiStore, type ReviewMode } from "@/store/ui";
import { useGithubAuth, useGithubPrs, useReviewFiles } from "./api";
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

  const auth = useGithubAuth();
  const prs = useGithubPrs(repoId, auth.data?.logged_in ?? false);
  const branches = useQuery({
    queryKey: ["branches", repoId],
    queryFn: () => ipc.listBranches(repoId!),
    enabled: repoId != null,
  });

  // Peek at both sources so we can auto-pick the one with changes (these share
  // the same query cache as the LocalReview below, so no extra fetches).
  const working = useReviewFiles(repoId, "working");
  const branchDiff = useReviewFiles(repoId, "branch");

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

  const currentBranch = branches.data?.find((b) => b.is_head)?.name;
  const matchingPr =
    currentBranch != null
      ? prs.data?.find((p) => p.head_ref === currentBranch)
      : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
        {MODES.map(({ mode: m, label }) => (
          <button
            key={m}
            onClick={() => setMode(m)}
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

        {mode === "branch" && matchingPr && (
          <div className="ml-auto flex items-center gap-2">
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
            pr={
              matchingPr
                ? { number: matchingPr.number, headSha: matchingPr.head_sha }
                : undefined
            }
          />
        )}
      </div>
    </div>
  );
}
