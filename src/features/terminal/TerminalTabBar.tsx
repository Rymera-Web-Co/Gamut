import { useState } from "react";
import { Maximize2, Minimize2, Plus, RotateCw, SplitSquareHorizontal, X } from "lucide-react";

import { useDraggable, useDropTarget } from "@/lib/usePointerDnd";
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
      {tabs.map((tab) => (
        <TabButton
          key={tab.id}
          tab={tab}
          activeGroupId={activeGroupId}
          isActive={tab.id === activeTabId}
          // Inactive tabs surface unseen background activity with a dot; the
          // active tab's focused pane is already "seen" (and cleared).
          activityKind={tab.id === activeTabId ? undefined : tabActivity(tab)}
          isEditing={editingTabId === tab.id}
          draftTitle={draftTitle}
          onDraftChange={setDraftTitle}
          onSelect={() => activeGroupId != null && selectTerminalTab(activeGroupId, tab.id)}
          onBeginRename={() => beginRename(tab)}
          onCommitRename={commitRename}
          onCancelRename={() => setEditingTabId(null)}
          onClose={() => onCloseTab(tab.id)}
          reorderTerminalTab={reorderTerminalTab}
        />
      ))}

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

// `useDraggable` requires a group id in the payload, but a tab with no active
// group is never draggable (see `disabled` below) and this value is therefore
// never matched against a drop target — it only satisfies the payload shape.
const NO_GROUP_ID = -1;

// Which half of a (horizontal) tab the pointer sits over — the insertion edge.
// Shared by the hover indicator (`compute`) and the drop handler so the two
// can't drift apart.
function tabDropSide(rect: DOMRect, x: number): "left" | "right" {
  return x > rect.left + rect.width / 2 ? "right" : "left";
}

/**
 * One tab in the strip: draggable to reorder (within its own group), a drop
 * target for a sibling tab, and inline-renameable. Extracted so each tab can own
 * its pointer drag-and-drop hooks.
 */
function TabButton({
  tab,
  activeGroupId,
  isActive,
  activityKind,
  isEditing,
  draftTitle,
  onDraftChange,
  onSelect,
  onBeginRename,
  onCommitRename,
  onCancelRename,
  onClose,
  reorderTerminalTab,
}: {
  tab: TermTab;
  activeGroupId: number | null;
  isActive: boolean;
  activityKind: TermActivityKind | undefined;
  isEditing: boolean;
  draftTitle: string;
  onDraftChange: (value: string) => void;
  onSelect: () => void;
  onBeginRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onClose: () => void;
  reorderTerminalTab: (
    groupId: number,
    srcId: string,
    targetId: string,
    position: "before" | "after",
  ) => void;
}) {
  // Don't start a drag while the label is being renamed — the input needs
  // normal text selection/caret behaviour — or with no active group.
  const drag = useDraggable(
    { kind: "tab", groupId: activeGroupId ?? NO_GROUP_ID, id: tab.id },
    termTabLabel(tab),
    { disabled: isEditing || activeGroupId == null },
  );
  // Only same-group tab drags reorder; the strip is horizontal, so the
  // insertion line lands on the nearer edge (left = before, right = after).
  const { ref, state: edge } = useDropTarget<"left" | "right", HTMLDivElement>({
    accepts: (d) => d.kind === "tab" && d.groupId === activeGroupId && d.id !== tab.id,
    compute: (_d, rect, x) => tabDropSide(rect, x),
    onDrop: (d, rect, x) => {
      if (d.kind === "tab" && activeGroupId != null) {
        reorderTerminalTab(
          activeGroupId,
          d.id,
          tab.id,
          tabDropSide(rect, x) === "right" ? "after" : "before",
        );
      }
    },
  });

  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={isActive}
      {...drag}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 cursor-pointer items-center gap-1.5 border-r border-[var(--color-border)] px-3",
        isActive
          ? "bg-[var(--color-background)] text-[var(--color-foreground)]"
          : "text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]",
        // Insertion line on the hovered edge — listed last so its colour wins
        // over the default right border.
        edge === "left" && "border-l-2 border-l-[var(--color-primary)]",
        edge === "right" && "border-r-2 border-r-[var(--color-primary)]",
      )}
    >
      {activityKind && <ActivityDot kind={activityKind} />}
      {isEditing ? (
        <input
          autoFocus
          value={draftTitle}
          placeholder={tab.title}
          aria-label={`Rename ${termTabLabel(tab)} terminal`}
          // Terminal labels are arbitrary names, not prose — don't let the
          // platform rewrite or flag them.
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(e) => onDraftChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          // A press in the input must not bubble up and start a tab drag.
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={onCommitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancelRename();
            }
          }}
          className="min-w-0 w-24 rounded border border-[var(--color-accent)] bg-[var(--color-background)] px-1 text-[var(--color-foreground)] outline-none"
        />
      ) : (
        <span
          className="min-w-0 truncate"
          title="Double-click to rename"
          onDoubleClick={onBeginRename}
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
        // Don't let a press on this button arm a tab drag.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="ml-0.5 flex size-4 shrink-0 items-center justify-center rounded hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
