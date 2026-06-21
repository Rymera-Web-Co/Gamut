import { useEffect } from "react";

import { useRepos } from "@/features/repos/api";
import { useUiStore } from "@/store/ui";

/**
 * Whether the currently-active repo is an actual git repository. Plain (non-git)
 * folders return `false`; when no repo is selected (or repos haven't loaded yet)
 * this defaults to `true` so the full tab set shows.
 */
export function useActiveRepoIsGit(): boolean {
  const repos = useRepos();
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  if (activeRepoId == null) return true;
  const repo = repos.data?.find((r) => r.id === activeRepoId);
  // Treat "not yet loaded" as a git repo to avoid flashing a stripped-down tab
  // bar before the repo list arrives.
  return repo ? repo.is_git_repo : true;
}

/**
 * Force the Files view whenever a non-git folder is the active entry. History,
 * Review, and Pull Requests are git-only and hidden for such folders, so the
 * content area must not stay on one of those views after selecting a plain
 * folder (it would render an empty/erroring git view). Mounted once at the app
 * root so it runs even while the repo sidebar is collapsed.
 */
export function useNonGitViewGuard() {
  const isGitRepo = useActiveRepoIsGit();
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  useEffect(() => {
    if (!isGitRepo && view !== "files") setView("files");
  }, [isGitRepo, view, setView]);
}
