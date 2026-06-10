import { GitPullRequestArrow } from "lucide-react";

import { Placeholder } from "@/components/layout/Placeholder";

export function ReviewView() {
  return (
    <Placeholder
      icon={GitPullRequestArrow}
      title="Review"
      milestone="M3"
      description="Self-review the current branch's changes (working tree + branch-vs-base) and review GitHub pull requests with inline diffs and comments."
    />
  );
}
