import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUiStore } from "@/store/ui";
import { useRepos } from "./api";
import { RepoConfigPanel } from "./RepoConfigPanel";

/**
 * Standalone modal for a single repo's git config (#306 follow-up — this used
 * to be a category inside the app-wide Settings dialog; a repo-scoped surface
 * doesn't belong there). Targets an explicit `repoConfigRepoId` from the
 * store rather than `activeRepoId`, so opening it from the sidebar's gear
 * button or context-menu item never navigates the app to that repo.
 */
export function RepoConfigDialog() {
  const repoId = useUiStore((s) => s.repoConfigRepoId);
  const closeRepoConfig = useUiStore((s) => s.closeRepoConfig);
  const repos = useRepos();
  const repo = repoId != null ? repos.data?.find((r) => r.id === repoId) : undefined;

  return (
    <Dialog
      open={repoId != null}
      onOpenChange={(open) => {
        if (!open) closeRepoConfig();
      }}
    >
      <DialogContent className="flex h-[32rem] max-h-[85vh] w-full max-w-3xl flex-col gap-0 overflow-hidden p-0">
        {/* The name identifies the repo at a glance; the path underneath is
            what actually disambiguates — repo names are folder-derived and
            routinely duplicated (several `docs` folders across projects). */}
        <DialogHeader className="shrink-0 gap-1 border-b px-6 py-4 pr-10">
          <DialogTitle className="truncate text-base font-semibold">
            {repo?.name ?? "Repo config"}
          </DialogTitle>
          {/* Falls back to the purpose, not an error: the panel below renders
              the "no longer available" message, and showing it twice reads as
              two separate problems. */}
          <DialogDescription className="truncate text-xs" title={repo?.path}>
            {repo?.path ?? "Repository git config"}
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          {repoId != null && <RepoConfigPanel repoId={repoId} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
