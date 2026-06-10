import { GitPullRequestArrow } from "lucide-react";

import { useUiStore } from "@/store/ui";
import { GitHubReview } from "./GitHubReview";

export function PullsView() {
  const repoId = useUiStore((s) => s.activeRepoId);

  if (repoId == null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <GitPullRequestArrow className="size-8 text-[var(--color-muted-foreground)]" />
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Select a repository from the left to view its pull requests.
        </p>
      </div>
    );
  }

  return <GitHubReview key={repoId} repoId={repoId} />;
}
