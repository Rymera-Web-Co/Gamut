import {
  FolderTree,
  GitBranch,
  GitCompare,
  GitPullRequestArrow,
  Moon,
  PanelLeft,
  PanelLeftClose,
  Settings,
  SquareTerminal,
  Sun,
} from "lucide-react";

import { BranchSwitcher } from "@/features/history/BranchSwitcher";
import { useGroups, useRepoStatuses, useRepos } from "@/features/repos/api";
import { SyncControls } from "@/features/sync/SyncControls";
import { ActivityDot, groupActivityKind } from "@/features/terminal/activity";
import { useActiveRepoIsGit } from "@/lib/useActiveRepo";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useUiStore, type View } from "@/store/ui";

const TABS: { view: View; label: string; icon: typeof GitBranch }[] = [
  { view: "files", label: "Files", icon: FolderTree },
  { view: "history", label: "History", icon: GitBranch },
  { view: "review", label: "Review", icon: GitCompare },
  { view: "pulls", label: "Pull Requests", icon: GitPullRequestArrow },
];

/**
 * The repo workspace header ("Model C"): breadcrumb (group / repo) and branch
 * chip on the left, the view tabs inline in the middle, and the repo actions
 * (pull, push, repo settings, terminal) on the right — one bar instead of the
 * old tabs-only strip.
 */
export function WorkspaceHeader() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const repoSidebarHidden = useUiStore((s) => s.repoSidebarHidden);
  const toggleRepoSidebar = useUiStore((s) => s.toggleRepoSidebar);
  const toggleTerminal = useUiStore((s) => s.toggleTerminal);
  const terminalOpen = useUiStore((s) => s.terminalOpen);
  const terminals = useUiStore((s) => s.terminals);
  const termActivity = useUiStore((s) => s.termActivity);
  const openRepoConfig = useUiStore((s) => s.openRepoConfig);

  // Non-git folders only have the Files tab — the rest are git-only.
  const isGitRepo = useActiveRepoIsGit();
  const tabs = isGitRepo ? TABS : TABS.filter((t) => t.view === "files");

  const theme = useTheme((s) => s.theme);
  const toggleTheme = useTheme((s) => s.toggle);

  const repos = useRepos();
  const groups = useGroups();
  const statuses = useRepoStatuses();
  const repo = (repos.data ?? []).find((r) => r.id === activeRepoId);
  const group = (groups.data ?? []).find((g) => g.id === activeGroupId);
  const status = (statuses.data ?? []).find((s) => s.id === activeRepoId);

  const canSync = isGitRepo && !!repo && !repo.missing;

  // With the sidebar hidden (or the panel closed) the sidebar's terminal rail
  // can't surface unseen bell/exit activity — badge the terminal toggle here so
  // "needs input"/"exited" is never invisible everywhere at once.
  const activity =
    activeGroupId != null && (repoSidebarHidden || !terminalOpen)
      ? groupActivityKind(terminals[activeGroupId], termActivity)
      : undefined;

  return (
    <div className="flex h-11 shrink-0 items-stretch gap-2 border-b bg-[var(--color-card)] pl-2 pr-2.5">
      <div className="flex items-center">
        <button
          aria-label={repoSidebarHidden ? "Show sidebar" : "Hide sidebar"}
          title={repoSidebarHidden ? "Show sidebar (⌘B)" : "Hide sidebar (⌘B)"}
          onClick={toggleRepoSidebar}
          className="flex size-7 items-center justify-center rounded-md text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
        >
          {repoSidebarHidden ? (
            <PanelLeft className="size-4" />
          ) : (
            <PanelLeftClose className="size-4" />
          )}
        </button>
      </div>

      {/* Breadcrumb: group / repo, plus the branch chip. */}
      <div className="flex min-w-0 shrink items-center gap-2">
        {repo ? (
          <>
            <div className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
              {group && (
                <>
                  <span className="hidden truncate text-[var(--color-muted-foreground)] sm:inline">
                    {group.name}
                  </span>
                  <span className="text-[var(--color-faint)]">/</span>
                </>
              )}
              <span className="truncate text-[13.5px] font-bold text-[var(--color-foreground)]">
                {repo.name}
              </span>
            </div>
            {canSync && (
              <span className="flex shrink-0 items-center gap-1">
                <BranchSwitcher repoId={repo.id} currentBranch={status?.branch} />
                {status?.has_uncommitted_changes && (
                  <span
                    aria-label="Uncommitted changes"
                    title="Uncommitted changes"
                    className="size-1.5 rounded-full bg-[var(--color-warning)]"
                  />
                )}
              </span>
            )}
          </>
        ) : (
          <span className="text-[13px] text-[var(--color-muted-foreground)]">
            No repository selected
          </span>
        )}
      </div>

      <div className="my-2.5 w-px shrink-0 bg-[var(--color-border)]" />

      {/* View tabs, inline in the header. */}
      <div className="flex min-w-0 flex-1 items-stretch gap-0.5">
        {repo &&
          tabs.map(({ view: v, label, icon: Icon }) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                "flex items-center gap-1.5 border-b-2 px-3 text-[12.5px] transition-colors",
                view === v
                  ? "border-[var(--color-primary)] font-semibold text-[var(--color-foreground)]"
                  : "border-transparent font-medium text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]",
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
      </div>

      {/* Repo actions. */}
      <div className="flex shrink-0 items-center gap-1">
        {canSync && (
          <>
            {/* Pull/push with the publish-branch confirmation flow (#300). */}
            <SyncControls repoId={repo.id} ahead={status?.ahead} behind={status?.behind} />
            <button
              aria-label="Repository settings"
              title="Repository settings"
              onClick={() => activeRepoId != null && openRepoConfig(activeRepoId)}
              className="flex size-7 items-center justify-center rounded-md border bg-[var(--color-muted)] text-[var(--color-secondary-foreground)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
            >
              <Settings className="size-3.5" />
            </button>
          </>
        )}
        <button
          aria-label="Toggle theme"
          title="Toggle theme (⌘J)"
          onClick={toggleTheme}
          className="flex size-7 items-center justify-center rounded-md text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
        >
          {theme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
        </button>
        <button
          aria-label="Toggle terminal"
          title="Toggle terminal (⌘`)"
          onClick={toggleTerminal}
          className="relative ml-0.5 flex size-7 items-center justify-center rounded-md bg-[var(--color-primary)] text-[var(--color-primary-foreground)] transition-[filter] hover:brightness-110"
        >
          <SquareTerminal className="size-3.5" />
          {activity && (
            <span className="absolute -right-0.5 -top-0.5 rounded-full bg-[var(--color-card)] p-px">
              <ActivityDot kind={activity} />
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
