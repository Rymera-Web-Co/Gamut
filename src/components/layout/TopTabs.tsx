import { GitBranch, GitPullRequestArrow, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BranchSwitcher } from "@/features/history/BranchSwitcher";
import { SyncControls } from "@/features/sync/SyncControls";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useUiStore, type View } from "@/store/ui";

const TABS: { view: View; label: string; icon: typeof GitBranch }[] = [
  { view: "history", label: "History", icon: GitBranch },
  { view: "review", label: "Review", icon: GitPullRequestArrow },
];

export function TopTabs() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  const theme = useTheme((s) => s.theme);
  const toggleTheme = useTheme((s) => s.toggle);

  return (
    <div className="flex h-10 shrink-0 items-stretch border-b">
      {activeRepoId != null && (
        <div className="flex items-center gap-1 px-2">
          <BranchSwitcher repoId={activeRepoId} />
          <SyncControls repoId={activeRepoId} />
        </div>
      )}
      {TABS.map(({ view: v, label, icon: Icon }) => (
        <button
          key={v}
          onClick={() => setView(v)}
          className={cn(
            "flex items-center gap-2 border-b-2 px-4 text-sm transition-colors",
            view === v
              ? "border-[var(--color-primary)] text-[var(--color-foreground)]"
              : "border-transparent text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]",
          )}
        >
          <Icon className="size-4" />
          {label}
        </button>
      ))}

      <div className="ml-auto flex items-center pr-2">
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          title="Toggle theme (⌘J)"
          onClick={toggleTheme}
        >
          {theme === "dark" ? <Sun /> : <Moon />}
        </Button>
      </div>
    </div>
  );
}
