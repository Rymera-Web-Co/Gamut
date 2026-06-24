import { useState, type DragEvent } from "react";
import { Maximize2, Minimize2, Plus, RotateCw, SplitSquareHorizontal, X } from "lucide-react";

import { clearDrag, getDrag, setDrag } from "@/lib/dnd";
import { cn } from "@/lib/utils";
import { ACTIVITY_PRIORITY, termTabLabel, type TermActivityKind, type TermTab } from "@/store/ui";
import { ActivityDot } from "./activity";

interface TerminalTabBarProps {
  tabs: TermTab[];
  activeGroupId: number | null;
  activeTabId: string | null;
  activeTab: TermTab | undefined;
  termActivity: Record<string, TermActivityKind>;
  terminalMaximized: boolean;
  canNewTab: boolean;
  /** The active pane's shell has exited — show the Restart control. */
  activeDead: boolean;
  selectTerminalTab: (groupId: number, tabId: string) => void;
  reorderTerminalTab: (
    groupId: number,
    srcId: string,
    targetId: string,
    position: "before" | "after",
  ) => void;
  renameTerminalTab: (groupId: number, tabId: string, title: string) => void;
  onNewTab: () => void;
  onSplit: () => void;
  onCloseTab: (tabId: string) => void;
  onRestart: () => void;
  onToggleMaximized: () => void;
  onHide: () => void;
}

/**
 * The terminal tab strip + window controls (split / new / maximize / hide),
 * extracted from TerminalPane (#143). Owns the inline-rename and drag-reorder
 * interaction state, which is local to the strip.
 */
export function TerminalTabBar({
  tabs,
  activeGroupId,
  activeTabId,
  activeTab,
  termActivity,
  terminalMaximized,
  canNewTab,
  activeDead,
  selectTerminalTab,
  reorderTerminalTab,
  renameTerminalTab,
  onNewTab,
  onSplit,
  onCloseTab,
  onRestart,
  onToggleMaximized,
  onHide,
}: TerminalTabBarProps) {
  // Inline tab-rename state: which tab's label is being edited, and its draft.
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  // While reordering by drag, which tab the cursor is over and on which side —
  // drives the insertion line (the strip is horizontal, so left/right).
  const [dragOverTab, setDragOverTab] = useState<{
    id: string;
    edge: "left" | "right";
  } | null>(null);

  function beginRename(tab: TermTab) {
    setEditingTabId(tab.id);
    setDraftTitle(termTabLabel(tab));
  }

  // Commit the draft (blank reverts to the default); a no-op once editing ended,
  // so the blur that fires after Enter/Esc doesn't double-apply.
  function commitRename() {
    if (editingTabId == null || activeGroupId == null) return;
    renameTerminalTab(activeGroupId, editingTabId, draftTitle);
    setEditingTabId(null);
  }

  // The most salient unseen-activity kind across a tab's panes, if any.
  function tabActivity(tab: TermTab): TermActivityKind | undefined {
    let best: TermActivityKind | undefined;
    for (const p of tab.panes) {
      const k = termActivity[p.id];
      if (k && (!best || ACTIVITY_PRIORITY[k] > ACTIVITY_PRIORITY[best])) best = k;
    }
    return best;
  }

  // Which side of a tab the cursor is on — before (left) or after (right).
  function tabEdgeFor(e: DragEvent<HTMLDivElement>): "left" | "right" {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientX > rect.left + rect.width / 2 ? "right" : "left";
  }

  return (
    <div
      className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-sidebar)] text-xs"
      // Double-clicking the empty part of the bar toggles maximize, mirroring
      // the desktop window-title convention. The guard limits this to the bar
      // itself so tab labels (rename) and control buttons keep their handlers.
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) onToggleMaximized();
      }}
    >
      {tabs.map((tab) => {
        // Inactive tabs surface unseen background activity with a dot; the
        // active tab's focused pane is already "seen" (and cleared).
        const tabKind = tab.id === activeTabId ? undefined : tabActivity(tab);
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeTabId}
            // Don't start a drag while the label is being renamed — the input
            // needs normal text selection/caret behaviour.
            draggable={editingTabId !== tab.id}
            onClick={() => activeGroupId != null && selectTerminalTab(activeGroupId, tab.id)}
            onDragStart={(e) => {
              if (activeGroupId == null) return;
              setDrag({ kind: "tab", groupId: activeGroupId, id: tab.id });
              e.dataTransfer.setData("text/plain", termTabLabel(tab));
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => {
              clearDrag();
              setDragOverTab(null);
            }}
            onDragOver={(e) => {
              const d = getDrag();
              // Only same-group tab drags reorder; ignore repo/group/cross-group.
              if (d?.kind !== "tab" || d.groupId !== activeGroupId || d.id === tab.id) {
                return;
              }
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDragOverTab({ id: tab.id, edge: tabEdgeFor(e) });
            }}
            onDragLeave={() => {
              setDragOverTab((cur) => (cur?.id === tab.id ? null : cur));
            }}
            onDrop={(e) => {
              const d = getDrag();
              if (
                d?.kind === "tab" &&
                d.groupId === activeGroupId &&
                d.id !== tab.id &&
                activeGroupId != null
              ) {
                e.preventDefault();
                reorderTerminalTab(
                  activeGroupId,
                  d.id,
                  tab.id,
                  tabEdgeFor(e) === "right" ? "after" : "before",
                );
              }
              setDragOverTab(null);
              clearDrag();
            }}
            className={cn(
              "flex min-w-0 cursor-pointer items-center gap-1.5 border-r border-[var(--color-border)] px-3",
              tab.id === activeTabId
                ? "bg-[var(--color-background)] text-[var(--color-foreground)]"
                : "text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]",
              // Insertion line on the hovered edge — listed last so its colour
              // wins over the default right border.
              dragOverTab?.id === tab.id &&
                dragOverTab.edge === "left" &&
                "border-l-2 border-l-[var(--color-primary)]",
              dragOverTab?.id === tab.id &&
                dragOverTab.edge === "right" &&
                "border-r-2 border-r-[var(--color-primary)]",
            )}
          >
            {tabKind && <ActivityDot kind={tabKind} />}
            {editingTabId === tab.id ? (
              <input
                autoFocus
                value={draftTitle}
                placeholder={tab.title}
                aria-label={`Rename ${termTabLabel(tab)} terminal`}
                // Terminal labels are arbitrary names, not prose — don't let
                // the platform rewrite or flag them.
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                onChange={(e) => setDraftTitle(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditingTabId(null);
                  }
                }}
                className="min-w-0 w-24 rounded border border-[var(--color-accent)] bg-[var(--color-background)] px-1 text-[var(--color-foreground)] outline-none"
              />
            ) : (
              <span
                className="min-w-0 truncate"
                title="Double-click to rename"
                onDoubleClick={() => beginRename(tab)}
              >
                {termTabLabel(tab)}
              </span>
            )}
            {tab.panes.length > 1 && (
              <span className="shrink-0 text-[10px] text-[var(--color-muted-foreground)]">
                ×{tab.panes.length}
              </span>
            )}
            <button
              aria-label={`Close ${termTabLabel(tab)} terminal`}
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.id);
              }}
              className="ml-0.5 flex size-4 shrink-0 items-center justify-center rounded hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}

      <div className="ml-auto flex items-center gap-0.5 pr-1 pl-1">
        {activeDead && (
          <button
            title="Restart shell"
            onClick={onRestart}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
          >
            <RotateCw className="size-3.5" />
            Restart
          </button>
        )}
        <button
          title="Split terminal (⌘D)"
          aria-label="Split terminal"
          disabled={!activeTab}
          onClick={onSplit}
          className="flex size-6 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)] disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <SplitSquareHorizontal className="size-4" />
        </button>
        <button
          title="New terminal (⌘T)"
          aria-label="New terminal"
          disabled={!canNewTab}
          onClick={onNewTab}
          className="flex size-6 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)] disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Plus className="size-4" />
        </button>
        <button
          title={terminalMaximized ? "Restore terminal (⌘⇧`)" : "Maximize terminal (⌘⇧`)"}
          aria-label={terminalMaximized ? "Restore terminal" : "Maximize terminal"}
          aria-pressed={terminalMaximized}
          onClick={onToggleMaximized}
          className="flex size-6 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
        >
          {terminalMaximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </button>
        <button
          title="Hide terminal (⌘`)"
          aria-label="Hide terminal"
          onClick={onHide}
          className="flex size-6 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
