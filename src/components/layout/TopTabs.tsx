import { GitBranch, GitPullRequestArrow } from "lucide-react";

import { cn } from "@/lib/utils";
import { useUiStore, type View } from "@/store/ui";

const TABS: { view: View; label: string; icon: typeof GitBranch }[] = [
  { view: "history", label: "History", icon: GitBranch },
  { view: "review", label: "Review", icon: GitPullRequestArrow },
];

export function TopTabs() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  return (
    <div className="flex h-10 shrink-0 items-stretch border-b">
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
    </div>
  );
}
