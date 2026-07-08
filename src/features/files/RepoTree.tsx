import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Columns2,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Link as LinkIcon,
  Pencil,
  TerminalSquare,
  Trash2,
} from "lucide-react";

import {
  ContextMenu,
  ContextMenuItem,
  type ContextMenuPosition,
} from "@/components/ui/context-menu";
import { copy } from "@/lib/clipboard";
import { fileReference, sendToActiveTerminal } from "@/features/terminal/sendToTerminal";
import { fileIcon } from "@/lib/fileIcons";
import { isMac } from "@/lib/shortcuts";
import { ipc, type DirEntry } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast";
import { useUiStore } from "@/store/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useDraggable, useDropTarget } from "@/lib/usePointerDnd";
import { useDirChildren } from "./api";
import {
  basename,
  flattenVisible,
  isDescendant,
  movablePaths,
  parentDir,
  rangePaths,
  topLevelPaths,
  type FlatRow,
} from "./treeSelection";

function join(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

/** Changed working-tree paths: a file→status map plus the set of directories
 * that contain a change (so they can be flagged too). */
export interface TreeChanges {
  files: Map<string, string>;
  dirs: Set<string>;
}

/** What the user right-clicked, plus where to anchor the menu. `"root"` is the
 * blank space below the tree — it only offers create actions, scoped to the repo
 * root (path = ""). */
interface MenuTarget {
  path: string;
  kind: "dir" | "file" | "root";
  pos: ContextMenuPosition;
}

/** An in-progress New File / New Folder, rendered as an inline input row inside
 * directory `dir` (root = ""). */
interface Pending {
  mode: "file" | "folder";
  dir: string;
}

/** An in-progress rename of an existing entry — the row is swapped for an inline
 * input seeded with its current name. */
interface Renaming {
  path: string;
  kind: "dir" | "file";
}

/**
 * The rename key for the current platform: Enter on macOS (Finder convention),
 * F2 elsewhere (Explorer / VS Code convention). Intentionally not routed through
 * the remappable global-shortcut system — it's contextual to a focused tree row,
 * not a global command.
 */
function isRenameKey(e: { key: string }): boolean {
  return isMac() ? e.key === "Enter" : e.key === "F2";
}

// Mirrors the status palette used by the diff FileTree.
function statusColor(status: string): string {
  switch (status) {
    case "added":
      return "#16a34a";
    case "deleted":
      return "#dc2626";
    case "renamed":
      return "#2563eb";
    default:
      return "#a16207";
  }
}

interface NodeProps {
  repoId: number;
  parentPath: string;
  depth: number;
  selectedPath: string | null;
  /** The multi-selection set — rows in it render highlighted. */
  selectedPaths: Set<string>;
  /** A row was clicked; RepoTree resolves it (plain/⌘-toggle/⇧-range) against
   * the event modifiers and decides whether to also open/toggle it. */
  onRowClick: (path: string, kind: "dir" | "file", e: MouseEvent) => void;
  changes: TreeChanges;
  openPaths: Set<string>;
  onContextMenu: (target: MenuTarget) => void;
  pending: Pending | null;
  creating: boolean;
  onCreate: (name: string) => void;
  onCancelCreate: () => void;
  renaming: Renaming | null;
  renamingBusy: boolean;
  onSubmitRename: (name: string) => void;
  onCancelRename: () => void;
  /** The highlighted row (last clicked/keyboard-focused) — the keyboard rename
   * target and the anchor row for arrow navigation. */
  active: string | null;
  /** Move the dragged entries into `targetDir` (root = ""). */
  onMove: (paths: string[], targetDir: string) => void;
}

function Entry({ entry, ...props }: NodeProps & { entry: DirEntry }) {
  const {
    repoId,
    parentPath,
    depth,
    selectedPath,
    selectedPaths,
    onRowClick,
    changes,
    openPaths,
    onContextMenu,
    renaming,
    renamingBusy,
    onSubmitRename,
    onCancelRename,
    active,
    onMove,
  } = props;
  const path = join(parentPath, entry.name);

  // Dragging a selected row carries the whole selection; an unselected row
  // carries just itself. Reuses the shared pointer-DnD (ghost + feel).
  const dragPaths = selectedPaths.has(path) ? [...selectedPaths] : [path];
  const drag = useDraggable(
    { kind: "tree", repoId, paths: dragPaths },
    dragPaths.length > 1 ? `${dragPaths.length} items` : entry.name,
  );

  // A drop on a row moves the dragged entries into that row's directory: a
  // folder row takes them *into* itself; a file row takes them into its
  // containing directory. Letting file rows accept drops is what makes moving an
  // entry *up* to a parent work — you can drop it onto any row already living in
  // the destination, not just the parent folder's (often off-screen, or for the
  // root nonexistent) header. `movablePaths` still rejects no-ops and moving a
  // folder into itself/a descendant.
  const dropDir = entry.kind === "dir" ? path : parentPath;
  const { ref: dropRef, state: dropOver } = useDropTarget<boolean, HTMLButtonElement>({
    accepts: (d) =>
      d.kind === "tree" && d.repoId === repoId && movablePaths(d.paths, dropDir).length > 0,
    compute: () => true,
    onDrop: (d) => {
      if (d.kind === "tree") onMove(d.paths, dropDir);
    },
  });

  const onCtx = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu({ path, kind: entry.kind, pos: { x: e.clientX, y: e.clientY } });
  };

  // Highlight the row when it's the keyboard rename target. A ring (rather than
  // the selection background) keeps it distinct from the selection highlight, so
  // both can show at once when they differ.
  const activeRing = active === path && "ring-1 ring-inset ring-[var(--color-primary)]";
  // While a valid move hovers this folder, flag it as the drop destination.
  const dropRing =
    dropOver && "bg-[var(--color-accent)] ring-1 ring-inset ring-[var(--color-primary)]";
  const isSelected = selectedPaths.has(path);

  // While this entry is being renamed, swap its row for the inline input.
  if (renaming?.path === path) {
    return (
      <RenameRow
        kind={entry.kind}
        name={entry.name}
        depth={depth}
        busy={renamingBusy}
        onSubmit={onSubmitRename}
        onCancel={onCancelRename}
      />
    );
  }

  if (entry.kind === "dir") {
    const open = openPaths.has(path);
    const hasChanges = changes.dirs.has(path);
    return (
      <div>
        <button
          ref={dropRef}
          data-tree-row
          aria-selected={isSelected}
          {...drag}
          onClick={(e) => onRowClick(path, "dir", e)}
          onContextMenu={onCtx}
          title={path}
          style={{ ...drag.style, paddingLeft: depth * 14 + 8 }}
          className={cn(
            "flex w-full items-center gap-1.5 py-1 pr-3 text-left text-sm hover:bg-[var(--color-accent)]",
            isSelected && "bg-[var(--color-accent)]",
            activeRing,
            dropRing,
            entry.is_ignored && "opacity-50",
          )}
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-[var(--color-muted-foreground)]" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-[var(--color-muted-foreground)]" />
          )}
          {open ? (
            <FolderOpen className="size-4 shrink-0 text-[var(--color-muted-foreground)]" />
          ) : (
            <Folder className="size-4 shrink-0 text-[var(--color-muted-foreground)]" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs">{entry.name}</span>
          {hasChanges && (
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: "#a16207" }}
              title="Contains changes"
            />
          )}
        </button>
        {open && <Children {...props} parentPath={path} depth={depth + 1} />}
      </div>
    );
  }

  const Icon = fileIcon(entry.name);
  const status = changes.files.get(path);
  const color = status ? statusColor(status) : undefined;
  return (
    <button
      ref={dropRef}
      data-tree-row
      aria-selected={isSelected}
      {...drag}
      onClick={(e) => onRowClick(path, "file", e)}
      onContextMenu={onCtx}
      title={path}
      style={{ ...drag.style, paddingLeft: depth * 14 + 8 }}
      className={cn(
        "flex w-full items-center gap-2 py-1 pr-3 text-left text-sm",
        isSelected || selectedPath === path
          ? "bg-[var(--color-accent)]"
          : "hover:bg-[var(--color-accent)]",
        activeRing,
        dropRing,
        entry.is_ignored && "opacity-50",
      )}
    >
      <Icon className="size-4 shrink-0 text-[var(--color-muted-foreground)]" />
      <span
        className="min-w-0 flex-1 truncate font-mono text-xs"
        style={color ? { color } : undefined}
      >
        {entry.name}
      </span>
      {status && (
        <span className="shrink-0 text-xs font-bold" style={{ color }} title={status}>
          {status[0].toUpperCase()}
        </span>
      )}
    </button>
  );
}

/** Inline name input for a New File / New Folder, rendered as a tree row. */
function CreateRow({
  mode,
  depth,
  busy,
  onSubmit,
  onCancel,
}: {
  mode: "file" | "folder";
  depth: number;
  busy: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const Icon = mode === "file" ? FilePlus : FolderPlus;
  const trimmed = name.trim();
  return (
    <div className="flex items-center gap-2 py-0.5 pr-3" style={{ paddingLeft: depth * 14 + 8 }}>
      <Icon className="size-4 shrink-0 text-[var(--color-muted-foreground)]" />
      <input
        autoFocus
        value={name}
        placeholder={mode === "file" ? "filename.ext" : "folder name"}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (trimmed && !busy) onSubmit(trimmed);
          } else if (e.key === "Escape") {
            onCancel();
          }
        }}
        // Click-away cancels, matching an inline rename. Skipped while a create
        // is in flight so the row doesn't vanish mid-submit.
        onBlur={() => {
          if (!busy) onCancel();
        }}
        className="min-w-0 flex-1 rounded-sm border border-[var(--color-primary)] bg-[var(--color-background)] px-1 py-0.5 font-mono text-xs outline-none"
      />
    </div>
  );
}

/** Inline rename input, rendered in place of the entry's row. Seeded with the
 * current name, with the file stem (name minus its extension) pre-selected so a
 * quick retype keeps the extension. */
function RenameRow({
  kind,
  name,
  depth,
  busy,
  onSubmit,
  onCancel,
}: {
  kind: "dir" | "file";
  name: string;
  depth: number;
  busy: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(name);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const Icon = kind === "dir" ? Folder : fileIcon(name);
  const trimmed = value.trim();

  // Select the stem on mount (dirs and dotfiles select the whole name).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const dot = kind === "file" ? name.lastIndexOf(".") : -1;
    el.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, [kind, name]);

  return (
    <div className="flex items-center gap-2 py-0.5 pr-3" style={{ paddingLeft: depth * 14 + 8 }}>
      <Icon className="size-4 shrink-0 text-[var(--color-muted-foreground)]" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // Ignore keys that belong to an in-progress IME composition, so an
          // Enter that commits composed CJK/etc. text (or an Escape that cancels
          // the composition) doesn't submit/cancel the rename with raw input.
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            if (trimmed && !busy) onSubmit(trimmed);
          } else if (e.key === "Escape") {
            onCancel();
          }
        }}
        // Click-away cancels, matching the create row. Skipped mid-submit so the
        // row doesn't vanish while the rename is in flight.
        onBlur={() => {
          if (!busy) onCancel();
        }}
        className="min-w-0 flex-1 rounded-sm border border-[var(--color-primary)] bg-[var(--color-background)] px-1 py-0.5 font-mono text-xs outline-none"
      />
    </div>
  );
}

function Children(props: NodeProps) {
  const { repoId, parentPath, depth, pending, creating, onCreate, onCancelCreate } = props;
  const { data, isLoading, isError } = useDirChildren(repoId, parentPath, true);

  const showCreate = pending != null && pending.dir === parentPath;
  const createRow = showCreate ? (
    <CreateRow
      mode={pending.mode}
      depth={depth}
      busy={creating}
      onSubmit={onCreate}
      onCancel={onCancelCreate}
    />
  ) : null;

  const indent = { paddingLeft: depth * 14 + 22 } as const;
  let body: ReactNode = null;
  if (isLoading) {
    body = (
      <p style={indent} className="py-1 text-xs text-[var(--color-muted-foreground)]">
        Loading…
      </p>
    );
  } else if (isError) {
    body = (
      <p style={indent} className="py-1 text-xs text-[var(--color-destructive)]">
        Failed to load
      </p>
    );
  } else {
    const entries = data ?? [];
    if (entries.length === 0) {
      // Suppress the "empty" hint while the inline create row holds the spot.
      body = showCreate ? null : (
        <p style={indent} className="py-1 text-xs italic text-[var(--color-muted-foreground)]">
          empty
        </p>
      );
    } else {
      body = entries.map((entry) => <Entry key={entry.name} entry={entry} {...props} />);
    }
  }

  return (
    <>
      {createRow}
      {body}
    </>
  );
}

/** Lazy directory tree over a repo's working tree (root = ""). */
export function RepoTree({
  repoId,
  selectedPath,
  onSelect,
  onDeleted,
  onRenamed,
  changes,
  groupRelativePrefix,
}: {
  repoId: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** A path (file or directory) was deleted — lets the editor drop it if open. */
  onDeleted: (path: string) => void;
  /** A path (file or directory) was renamed/moved — lets the editor follow it if
   * the open file lived under `from`. */
  onRenamed: (from: string, to: string) => void;
  changes: TreeChanges;
  /**
   * The repo's directory relative to its synced group's folder (e.g.
   * `"foo/bar"`, or `""` when the repo is the folder root). When non-null, a
   * "Copy Path (relative to group)" menu item is offered, joining this prefix
   * with the file's repo-relative path. Null hides the item — the repo isn't
   * in a folder-bound group, or doesn't live under that folder (#173).
   */
  groupRelativePrefix: string | null;
}) {
  const queryClient = useQueryClient();
  // File Compare (#130), VSCode-style: "Select for Compare" stashes a file
  // app-globally, then "Compare with Selected" diffs it against another file.
  const compareSelection = useUiStore((s) => s.compareSelection);
  const setCompareSelection = useUiStore((s) => s.setCompareSelection);
  const openCompare = useUiStore((s) => s.openCompare);
  // Expansion is lifted here so a create can force the target dir open and the
  // new entry becomes visible immediately.
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [renamingBusy, setRenamingBusy] = useState(false);
  // The highlighted row (last clicked or keyboard-focused) — the target for the
  // rename shortcut. Tracked explicitly rather than via DOM focus: WebKit
  // (Tauri's macOS webview) doesn't focus <button>s on click, so a focused-row
  // key handler would never fire there.
  const [active, setActive] = useState<Renaming | null>(null);
  // Multi-selection (⌘/Ctrl-click, ⇧-click range, ⇧+Arrow). `anchor` is the row
  // a range extends from (in flattened, on-screen order).
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);

  // Path-keyed state, so drop it when switching repos to avoid carrying one
  // repo's open dirs / in-progress create into another.
  useEffect(() => {
    setOpenPaths(new Set());
    setMenu(null);
    setPending(null);
    setRenaming(null);
    setRenamingBusy(false);
    setActive(null);
    setSelectedPaths(new Set());
    setAnchor(null);
  }, [repoId]);

  // The tree flattened to its on-screen row order, read from the React Query
  // cache. Used to resolve ⇧-click ranges and arrow-key navigation.
  const flatten = useCallback(
    () =>
      flattenVisible(
        (dir) => queryClient.getQueryData<DirEntry[]>(["dir", repoId, dir]),
        openPaths,
      ),
    [queryClient, repoId, openPaths],
  );

  const startRename = useCallback((target: Renaming) => {
    setRenaming(target);
    setMenu(null);
  }, []);

  // Rename the highlighted row on the platform rename key (Enter on macOS, F2
  // elsewhere). A window listener — not a per-row key handler — because the tree
  // rows can't reliably hold DOM focus under WebKit. RepoTree only mounts while
  // the Files view is active, so this can't fire from other views.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!isRenameKey(e)) return;
      // Don't hijack the key while an inline input or the context menu is open.
      if (!active || renaming || pending || menu) return;
      // Leave the key alone when the user is typing or in the editor/terminal.
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      if (el?.closest(".monaco-editor, .xterm")) return;
      e.preventDefault();
      startRename(active);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, renaming, pending, menu, startRename]);

  const onToggle = useCallback((path: string) => {
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Resolve a row click against its modifiers: ⌘/Ctrl toggles the row in/out of
  // the selection, ⇧ selects the range from the anchor, and a plain click
  // single-selects and opens (file) or expands (dir) it.
  const onRowClick = useCallback(
    (path: string, kind: "dir" | "file", e: MouseEvent) => {
      setActive({ path, kind });
      if (e.metaKey || e.ctrlKey) {
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
        setAnchor(path);
        return;
      }
      if (e.shiftKey) {
        const from = anchor ?? active?.path ?? path;
        setSelectedPaths(new Set(rangePaths(flatten(), from, path)));
        setAnchor((a) => a ?? path);
        return;
      }
      setSelectedPaths(new Set([path]));
      setAnchor(path);
      if (kind === "dir") onToggle(path);
      else onSelect(path);
    },
    [anchor, active, flatten, onToggle, onSelect],
  );

  // Arrow-key navigation over the flattened tree (nice-to-have, #235). Same
  // window-listener rationale as the rename shortcut: WebKit won't hold DOM
  // focus on the rows. Only engages once a row is active (the user has clicked
  // into the tree), so it can't hijack arrows elsewhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(e.key)) return;
      if (!active || renaming || pending || menu) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      if (el?.closest(".monaco-editor, .xterm")) return;

      // Enter opens/toggles — but only where it isn't the platform rename key
      // (macOS uses Enter to rename, handled by the effect above).
      if (e.key === "Enter") {
        if (isRenameKey(e)) return;
        e.preventDefault();
        if (active.kind === "dir") onToggle(active.path);
        else onSelect(active.path);
        return;
      }

      const flat = flatten();
      const idx = flat.findIndex((r) => r.path === active.path);
      if (idx === -1) return;

      // Move the highlight to `row`: ⇧ extends the selection from the anchor,
      // a plain arrow single-selects and re-anchors.
      const moveTo = (row: FlatRow) => {
        setActive({ path: row.path, kind: row.kind });
        if (e.shiftKey) {
          setSelectedPaths(new Set(rangePaths(flat, anchor ?? active.path, row.path)));
        } else {
          setSelectedPaths(new Set([row.path]));
          setAnchor(row.path);
        }
      };

      if (e.key === "ArrowDown") {
        const next = flat[idx + 1];
        if (next) {
          e.preventDefault();
          moveTo(next);
        }
      } else if (e.key === "ArrowUp") {
        const prev = flat[idx - 1];
        if (prev) {
          e.preventDefault();
          moveTo(prev);
        }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        // Closed dir → expand; open dir → step into its first child.
        if (active.kind === "dir") {
          if (!openPaths.has(active.path)) onToggle(active.path);
          else {
            const next = flat[idx + 1];
            if (next && isDescendant(next.path, active.path)) moveTo(next);
          }
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        // Open dir → collapse; otherwise step out to the parent dir.
        if (active.kind === "dir" && openPaths.has(active.path)) {
          onToggle(active.path);
        } else {
          const parent = parentDir(active.path);
          if (parent) {
            setActive({ path: parent, kind: "dir" });
            setSelectedPaths(new Set([parent]));
            setAnchor(parent);
          }
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, renaming, pending, menu, openPaths, anchor, flatten, onToggle, onSelect]);

  // Move one or more entries into `targetDir` (root = ""), backed by the
  // rename primitive. No-op moves and folder-into-descendant moves are dropped
  // by `movablePaths`; conflicts (a name already there) surface as an error.
  const movePaths = useCallback(
    async (paths: string[], targetDir: string) => {
      const movable = movablePaths(paths, targetDir);
      if (movable.length === 0) return;
      const moved: Array<{ from: string; to: string }> = [];
      let failed = 0;
      let lastErr: unknown;
      for (const from of movable) {
        const to = join(targetDir, basename(from));
        try {
          await ipc.renamePath(repoId, from, to);
          moved.push({ from, to });
        } catch (err) {
          failed += 1;
          lastErr = err;
        }
      }
      if (moved.length === 0) {
        toast.error(String(lastErr));
        return;
      }
      // Refresh every affected directory (each source plus the destination).
      const dirs = new Set<string>([targetDir]);
      for (const { from } of moved) dirs.add(parentDir(from));
      await Promise.all(
        [...dirs].map((d) => queryClient.invalidateQueries({ queryKey: ["dir", repoId, d] })),
      );
      // Rewrite a path across every move it (or an ancestor) took part in, so
      // open dirs / active row / selection / anchor follow their entries.
      const remap = (p: string) => {
        for (const { from, to } of moved) {
          if (p === from) return to;
          if (p.startsWith(`${from}/`)) return `${to}${p.slice(from.length)}`;
        }
        return p;
      };
      setOpenPaths((prev) => {
        const next = new Set<string>();
        for (const p of prev) next.add(remap(p));
        // Keep the destination expanded so the moved rows are visible.
        if (targetDir) next.add(targetDir);
        return next;
      });
      setSelectedPaths(new Set(moved.map((m) => m.to)));
      setActive((a) => (a ? { path: remap(a.path), kind: a.kind } : a));
      setAnchor((an) => (an != null ? remap(an) : an));
      // Let the editor follow any open file that lived under a moved entry.
      for (const { from, to } of moved) onRenamed(from, to);
      if (failed > 0) toast.error(`Moved ${moved.length}, ${failed} failed`);
      else if (moved.length > 1) toast.success(`Moved ${moved.length} items`);
      else toast.success(`Moved to ${moved[0].to}`);
    },
    [repoId, queryClient, onRenamed],
  );

  // Where a create on the menu target should land. A directory (or the blank
  // root) targets itself; a file targets its parent.
  const targetDir = menu ? (menu.kind === "file" ? parentDir(menu.path) : menu.path) : "";

  function startCreate(mode: "file" | "folder") {
    // Force the target dir open so its inline input row is visible.
    if (targetDir) setOpenPaths((prev) => new Set(prev).add(targetDir));
    setPending({ mode, dir: targetDir });
    setMenu(null);
  }

  async function submitCreate(name: string) {
    if (!pending) return;
    if (name.includes("/")) {
      toast.error("Name can't contain a slash");
      return;
    }
    const path = join(pending.dir, name);
    setBusy(true);
    try {
      if (pending.mode === "file") {
        await ipc.createFile(repoId, path);
      } else {
        await ipc.createDir(repoId, path);
      }
      // Refresh the affected directory; it's already open from startCreate.
      await queryClient.invalidateQueries({ queryKey: ["dir", repoId, pending.dir] });
      if (pending.mode === "file") onSelect(path);
      toast.success(`Created ${path}`);
      setPending(null);
    } catch (e) {
      // Keep the row open (name preserved) so the user can fix and retry.
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitRename(name: string) {
    if (!renaming) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Name can't be empty");
      return;
    }
    if (trimmed === "." || trimmed === "..") {
      toast.error("Invalid name");
      return;
    }
    if (trimmed.includes("/")) {
      toast.error("Name can't contain a slash");
      return;
    }
    const from = renaming.path;
    // No-op rename (same name): just close the input.
    if (trimmed === basename(from)) {
      setRenaming(null);
      return;
    }
    const to = join(parentDir(from), trimmed);
    setRenamingBusy(true);
    try {
      await ipc.renamePath(repoId, from, to);
      // Refresh the containing directory so both names update in one place.
      await queryClient.invalidateQueries({ queryKey: ["dir", repoId, parentDir(from)] });
      // Carry expansion across the rename: the renamed dir (and its open
      // descendants) move under the new prefix.
      setOpenPaths((prev) => {
        const next = new Set<string>();
        for (const p of prev) {
          if (p === from) next.add(to);
          else if (p.startsWith(`${from}/`)) next.add(`${to}${p.slice(from.length)}`);
          else next.add(p);
        }
        return next;
      });
      onRenamed(from, to);
      // Keep the highlight on the renamed entry so a follow-up shortcut targets it.
      setActive({ path: to, kind: renaming.kind });
      toast.success(`Renamed to ${to}`);
      setRenaming(null);
    } catch (e) {
      // Keep the row open (name preserved) so the user can fix and retry.
      toast.error(String(e));
    } finally {
      setRenamingBusy(false);
    }
  }

  // Diff the previously "Select for Compare" file against `target`. Both are
  // resolved to absolute paths (they may be in different repos) and fed to the
  // two-files compare flow.
  async function compareWithSelected(target: MenuTarget) {
    if (!compareSelection) return;
    setMenu(null);
    try {
      const [leftPath, rightPath] = await Promise.all([
        ipc.resolvePath(compareSelection.repoId, compareSelection.path),
        ipc.resolvePath(repoId, target.path),
      ]);
      openCompare({ files: { leftPath, rightPath } });
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function deleteTarget(target: MenuTarget) {
    const ok = window.confirm(
      target.kind === "dir"
        ? `Delete folder "${target.path}" and everything inside it? This cannot be undone.`
        : `Delete "${target.path}"? This cannot be undone.`,
    );
    if (!ok) return;
    try {
      await ipc.deletePath(repoId, target.path);
      await queryClient.invalidateQueries({
        queryKey: ["dir", repoId, parentDir(target.path)],
      });
      // Drop the deleted dir (and any of its descendants) from the open set.
      setOpenPaths((prev) => {
        const next = new Set<string>();
        for (const p of prev) {
          if (p !== target.path && !p.startsWith(`${target.path}/`)) next.add(p);
        }
        return next;
      });
      // Clear the highlight if it pointed at what we just removed.
      setActive((a) =>
        a && (a.path === target.path || a.path.startsWith(`${target.path}/`)) ? null : a,
      );
      onDeleted(target.path);
      toast.success(`Deleted ${target.path}`);
    } catch (e) {
      toast.error(String(e));
    }
  }

  // Bulk-delete the current multi-selection behind a single confirm. Collapse
  // to top-level entries first: deleting a folder already removes its selected
  // descendants, so deleting them again would fail on a now-missing path.
  async function deleteSelection(selection: string[]) {
    const paths = topLevelPaths(selection);
    const ok = window.confirm(
      `Delete ${selection.length} selected items? Folders and everything inside them will be removed. This cannot be undone.`,
    );
    if (!ok) return;
    const deleted: string[] = [];
    let failed = 0;
    let lastErr: unknown;
    for (const p of paths) {
      try {
        await ipc.deletePath(repoId, p);
        deleted.push(p);
      } catch (err) {
        failed += 1;
        lastErr = err;
      }
    }
    if (deleted.length === 0) {
      toast.error(String(lastErr));
      return;
    }
    const dirs = new Set(deleted.map(parentDir));
    await Promise.all(
      [...dirs].map((d) => queryClient.invalidateQueries({ queryKey: ["dir", repoId, d] })),
    );
    // Drop every deleted entry (and its descendants) from the open set, the
    // highlight, and the selection.
    setOpenPaths((prev) => {
      const next = new Set<string>();
      for (const p of prev) {
        if (!deleted.some((d) => isDescendant(p, d))) next.add(p);
      }
      return next;
    });
    setActive((a) => (a && deleted.some((d) => isDescendant(a.path, d)) ? null : a));
    setSelectedPaths(new Set());
    setAnchor(null);
    for (const p of deleted) onDeleted(p);
    if (failed > 0) toast.error(`Deleted ${deleted.length}, ${failed} failed`);
    else toast.success(`Deleted ${deleted.length} items`);
  }

  // A right-clicked row that isn't already part of the multi-selection replaces
  // it (matching Finder / VS Code); a click inside the selection keeps it so the
  // menu can act on the whole set.
  function openRowMenu(target: MenuTarget) {
    if (target.kind !== "root") {
      setSelectedPaths((prev) => (prev.has(target.path) ? prev : new Set([target.path])));
      setActive({ path: target.path, kind: target.kind });
    }
    setMenu(target);
  }

  // Whether the current context-menu row is part of a multi-selection — bulk
  // actions (Delete) then operate on the whole selection.
  const menuBulk = menu != null && selectedPaths.has(menu.path) && selectedPaths.size > 1;

  // Detect whether a released pointer landed on a tree row, so the root-level
  // drop zone below only claims genuinely-blank space. Every row now owns its own
  // drop (a folder into itself, a file into its parent dir), so the zone defers
  // to any row and only handles the empty area.
  const overRow = (x: number, y: number) =>
    !!(document.elementFromPoint(x, y) as HTMLElement | null)?.closest("[data-tree-row]");

  // Dropping on blank space (not over any row) moves the entries to the repo
  // root. The zone spans the whole scroll area, so it's gated on `overRow` to
  // defer to any row that would handle the drop itself.
  const { ref: rootDropRef, state: rootOver } = useDropTarget<boolean, HTMLDivElement>({
    accepts: (d) =>
      d.kind === "tree" && d.repoId === repoId && movablePaths(d.paths, "").length > 0,
    compute: (_d, _rect, x, y) => !overRow(x, y),
    onDrop: (d, _rect, x, y) => {
      if (d.kind === "tree" && !overRow(x, y)) void movePaths(d.paths, "");
    },
  });

  return (
    <>
      {/* The wrapper fills the scroll area so right-clicking the blank space
          below the tree opens a root-scoped create menu. Entry rows stop
          propagation in their own handler, so only genuinely empty space (and
          the empty/loading hints) bubbles up to here. */}
      <div
        ref={rootDropRef}
        className={cn(
          "min-h-full",
          rootOver && "rounded-sm ring-1 ring-inset ring-[var(--color-primary)]",
        )}
        onContextMenu={(e) => {
          e.preventDefault();
          openRowMenu({ path: "", kind: "root", pos: { x: e.clientX, y: e.clientY } });
        }}
      >
        <Children
          repoId={repoId}
          parentPath=""
          depth={0}
          selectedPath={selectedPath}
          selectedPaths={selectedPaths}
          onRowClick={onRowClick}
          changes={changes}
          openPaths={openPaths}
          onContextMenu={openRowMenu}
          pending={pending}
          creating={busy}
          onCreate={submitCreate}
          onCancelCreate={() => setPending(null)}
          renaming={renaming}
          renamingBusy={renamingBusy}
          onSubmitRename={submitRename}
          onCancelRename={() => setRenaming(null)}
          active={active?.path ?? null}
          onMove={movePaths}
        />
      </div>

      <ContextMenu at={menu?.pos ?? null} onClose={() => setMenu(null)}>
        <ContextMenuItem className="text-xs" onClick={() => startCreate("file")}>
          <FilePlus />
          New File…
        </ContextMenuItem>
        <ContextMenuItem className="text-xs" onClick={() => startCreate("folder")}>
          <FolderPlus />
          New Folder…
        </ContextMenuItem>
        {/* The remaining actions act on a specific entry; they're hidden for the
            blank-space (root) menu, which only creates. */}
        {menu && menu.kind !== "root" && (
          <>
            <div className="my-1 border-t border-[var(--color-border)]" />
            <ContextMenuItem
              className="text-xs"
              onClick={() => {
                const path = menu.path;
                setMenu(null);
                ipc
                  .resolvePath(repoId, path)
                  .then((abs) => copy(abs, "Copied path"))
                  .catch((e) => toast.error(String(e)));
              }}
            >
              <LinkIcon />
              Copy Path
            </ContextMenuItem>
            <ContextMenuItem
              className="text-xs"
              onClick={() => {
                void copy(menu.path, "Copied relative path");
                setMenu(null);
              }}
            >
              <LinkIcon />
              Copy Relative Path
            </ContextMenuItem>
            {groupRelativePrefix != null && (
              <ContextMenuItem
                className="text-xs"
                onClick={() => {
                  const rel = groupRelativePrefix
                    ? `${groupRelativePrefix}/${menu.path}`
                    : menu.path;
                  void copy(rel, "Copied group-relative path");
                  setMenu(null);
                }}
              >
                <LinkIcon />
                Copy Path (relative to group)
              </ContextMenuItem>
            )}
            <div className="my-1 border-t border-[var(--color-border)]" />
            <ContextMenuItem
              className="text-xs"
              onClick={() => {
                // File tree carries no selection, so the reference is the
                // repo-relative path only — no line range (#199).
                sendToActiveTerminal(fileReference(menu.path));
                setMenu(null);
              }}
            >
              <TerminalSquare />
              Send to Terminal
            </ContextMenuItem>
            {menu.kind === "file" && (
              <>
                <div className="my-1 border-t border-[var(--color-border)]" />
                <ContextMenuItem
                  className="text-xs"
                  onClick={() => {
                    setCompareSelection({ repoId, path: menu.path });
                    setMenu(null);
                  }}
                >
                  <Columns2 />
                  Select for Compare
                </ContextMenuItem>
                {compareSelection &&
                  !(compareSelection.repoId === repoId && compareSelection.path === menu.path) && (
                    <ContextMenuItem
                      className="text-xs"
                      onClick={() => void compareWithSelected(menu)}
                    >
                      <Columns2 />
                      Compare with Selected
                    </ContextMenuItem>
                  )}
              </>
            )}
            <div className="my-1 border-t border-[var(--color-border)]" />
            {/* Rename acts on a single entry, so it's hidden for a bulk menu. */}
            {!menuBulk && (
              <ContextMenuItem
                className="text-xs"
                onClick={() =>
                  menu.kind !== "root" && startRename({ path: menu.path, kind: menu.kind })
                }
              >
                <Pencil />
                Rename…
              </ContextMenuItem>
            )}
            <ContextMenuItem
              className="text-xs text-[var(--color-destructive)] [&_svg]:text-[var(--color-destructive)]"
              onClick={() => {
                const target = menu;
                const paths = [...selectedPaths];
                setMenu(null);
                if (menuBulk) void deleteSelection(paths);
                else void deleteTarget(target);
              }}
            >
              <Trash2 />
              {menuBulk ? `Delete ${selectedPaths.size} items` : "Delete"}
            </ContextMenuItem>
          </>
        )}
      </ContextMenu>
    </>
  );
}
