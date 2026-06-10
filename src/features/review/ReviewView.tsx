import { useQuery } from "@tanstack/react-query";
import { GitCompare, GitPullRequestArrow } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useUiStore, type ReviewMode } from "@/store/ui";
import { useGithubAuth, useGithubPrs } from "./api";
import { LocalReview } from "./LocalReview";

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
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            title={`Open pull request #${matchingPr.number}`}
            onClick={() => {
              setSelectedPr(matchingPr.number);
              setView("pulls");
            }}
          >
            <GitPullRequestArrow />
            View PR #{matchingPr.number}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1">
        <LocalReview key={`${repoId}-${mode}`} repoId={repoId} source={mode} />
      </div>
    </div>
  );
}
