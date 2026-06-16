import { useState } from "react";
import {
  FolderTree,
  GitBranch,
  GitCompare,
  GitPullRequestArrow,
  Moon,
  PanelLeft,
  PanelLeftClose,
  Settings,
  Sun,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuItem,
  type ContextMenuPosition,
} from "@/components/ui/context-menu";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useUiStore, type View } from "@/store/ui";

const TABS: { view: View; label: string; icon: typeof GitBranch }[] = [
  { view: "files", label: "Files", icon: FolderTree },
  { view: "history", label: "History", icon: GitBranch },
  { view: "review", label: "Review", icon: GitCompare },
  { view: "pulls", label: "Pull Requests", icon: GitPullRequestArrow },
];

export function TopTabs() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const repoSidebarHidden = useUiStore((s) => s.repoSidebarHidden);
  const toggleRepoSidebar = useUiStore((s) => s.toggleRepoSidebar);
  const toggleSettings = useUiStore((s) => s.toggleSettings);
  const theme = useTheme((s) => s.theme);
  const toggleTheme = useTheme((s) => s.toggle);
  const [menu, setMenu] = useState<ContextMenuPosition | null>(null);

  return (
    <div
      className="flex h-10 shrink-0 items-stretch border-b"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
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

      <div className="ml-auto flex items-center gap-1 pr-2">
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          title={
            repoSidebarHidden
              ? "Show repositories (⌘B)"
              : "Hide repositories (⌘B)"
          }
          onClick={toggleRepoSidebar}
        >
          {repoSidebarHidden ? <PanelLeft /> : <PanelLeftClose />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          title="Toggle theme (⌘J)"
          onClick={toggleTheme}
        >
          {theme === "dark" ? <Sun /> : <Moon />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          title="Settings (⌘,)"
          onClick={toggleSettings}
        >
          <Settings />
        </Button>
      </div>

      <ContextMenu at={menu} onClose={() => setMenu(null)}>
        <ContextMenuItem
          onClick={() => {
            toggleRepoSidebar();
            setMenu(null);
          }}
        >
          {repoSidebarHidden ? <PanelLeft /> : <PanelLeftClose />}
          {repoSidebarHidden ? "Show repositories" : "Hide repositories"}
          <span className="ml-auto pl-4 text-xs text-[var(--color-muted-foreground)]">
            ⌘B
          </span>
        </ContextMenuItem>
      </ContextMenu>
    </div>
  );
}
