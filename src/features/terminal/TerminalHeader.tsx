import { Folder } from "lucide-react";

import { useGroups } from "@/features/repos/api";
import { termTabLabel, useUiStore } from "@/store/ui";
import { tabActivityKind, activityColor } from "./activity";

/**
 * Header bar above the full-view terminal: a group / folder / session
 * breadcrumb on the left and an "Open repo workspace" button on the right,
 * which switches the main area back to the repo views (Files, History,
 * Review, Pull Requests).
 */
export function TerminalHeader() {
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const terminals = useUiStore((s) => s.terminals);
  const termActivity = useUiStore((s) => s.termActivity);
  const setTerminalOpen = useUiStore((s) => s.setTerminalOpen);

  const groups = useGroups();
  const group = (groups.data ?? []).find((g) => g.id === activeGroupId);

  const gt = activeGroupId != null ? terminals[activeGroupId] : undefined;
  const tab = gt?.tabs.find((t) => t.id === gt.activeTabId);
  const cwd = tab?.panes.find((p) => p.id === tab.activePaneId)?.cwd ?? tab?.panes[0]?.cwd;
  const folder = cwd?.split(/[\\/]/).filter(Boolean).pop();
  const activity = tab ? tabActivityKind(tab, termActivity) : undefined;

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b bg-[var(--color-card)] px-4">
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{
          background: activity ? activityColor(activity) : "var(--color-primary)",
          animation: activity ? undefined : "gamut-pulse 1.6s ease-in-out infinite",
        }}
      />
      <div className="flex min-w-0 items-baseline gap-2 text-[13px]">
        {group && (
          <>
            <span className="truncate text-[var(--color-muted-foreground)]">{group.name}</span>
            <span className="text-[var(--color-faint)]">/</span>
          </>
        )}
        {folder && (
          <>
            <span className="truncate text-[var(--color-muted-foreground)]">{folder}</span>
            <span className="text-[var(--color-faint)]">/</span>
          </>
        )}
        <span className="truncate font-semibold text-[var(--color-foreground)]">
          {tab ? termTabLabel(tab) : "Terminal"}
        </span>
      </div>
      <div className="flex-1" />
      <button
        onClick={() => setTerminalOpen(false)}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border bg-[var(--color-muted)] px-2.5 text-xs font-medium text-[var(--color-secondary-foreground)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
      >
        <Folder className="size-3.5" />
        Open repo workspace
      </button>
    </div>
  );
}
