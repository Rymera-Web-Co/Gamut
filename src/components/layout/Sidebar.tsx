import { FolderGit2, GitBranch, GitPullRequestArrow } from "lucide-react";

import { cn } from "@/lib/utils";
import { useUiStore, type View } from "@/store/ui";

const NAV: { view: View; label: string; icon: typeof FolderGit2 }[] = [
  { view: "repos", label: "Repositories", icon: FolderGit2 },
  { view: "history", label: "History", icon: GitBranch },
  { view: "review", label: "Review", icon: GitPullRequestArrow },
];

export function Sidebar() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  return (
    <nav
      className="flex w-14 shrink-0 flex-col items-center gap-1 border-r py-3"
      style={{ background: "var(--color-sidebar)" }}
      aria-label="Primary"
    >
      {NAV.map(({ view: v, label, icon: Icon }) => (
        <button
          key={v}
          title={label}
          aria-label={label}
          aria-current={view === v}
          onClick={() => setView(v)}
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-md transition-colors",
            view === v
              ? "bg-[var(--color-accent)] text-[var(--color-foreground)]"
              : "text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]",
          )}
        >
          <Icon className="size-5" />
        </button>
      ))}
    </nav>
  );
}
