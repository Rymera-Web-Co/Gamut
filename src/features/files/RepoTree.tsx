import {
  useCallback,
  useEffect,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Link as LinkIcon,
} from "lucide-react";

import {
  ContextMenu,
  ContextMenuItem,
  type ContextMenuPosition,
} from "@/components/ui/context-menu";
import { copy } from "@/lib/clipboard";
import { fileIcon } from "@/lib/fileIcons";
import { ipc, type DirEntry } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast";
import { useQueryClient } from "@tanstack/react-query";
import { useDirChildren } from "./api";

function join(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

/** The directory a create lands in: a directory targets itself, a file targets
 * its parent (root = ""). */
function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Changed working-tree paths: a file→status map plus the set of directories
 * that contain a change (so they can be flagged too). */
export interface TreeChanges {
  files: Map<string, string>;
  dirs: Set<string>;
}

/** What the user right-clicked, plus where to anchor the menu. */
interface MenuTarget {
  path: string;
  kind: "dir" | "file";
  pos: ContextMenuPosition;
}

/** An in-progress New File / New Folder, rendered as an inline input row inside
 * directory `dir` (root = ""). */
interface Pending {
  mode: "file" | "folder";
  dir: string;
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
  onSelect: (path: string) => void;
  changes: TreeChanges;
  openPaths: Set<string>;
  onToggle: (path: string) => void;
  onContextMenu: (target: MenuTarget) => void;
  pending: Pending | null;
  creating: boolean;
  onCreate: (name: string) => void;
  onCancelCreate: () => void;
}

function Entry({
  entry,
  ...props
}: NodeProps & { entry: DirEntry }) {
  const {
    parentPath,
    depth,
    selectedPath,
    onSelect,
    changes,
    openPaths,
    onToggle,
    onContextMenu,
  } = props;
  const path = join(parentPath, entry.name);

  const onCtx = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu({ path, kind: entry.kind, pos: { x: e.clientX, y: e.clientY } });
  };

  if (entry.kind === "dir") {
    const open = openPaths.has(path);
    const hasChanges = changes.dirs.has(path);
    return (
      <div>
        <button
          onClick={() => onToggle(path)}
          onContextMenu={onCtx}
          title={path}
          style={{ paddingLeft: depth * 14 + 8 }}
          className={cn(
            "flex w-full items-center gap-1.5 py-1 pr-3 text-left text-sm hover:bg-[var(--color-accent)]",
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
      onClick={() => onSelect(path)}
      onContextMenu={onCtx}
      title={path}
      style={{ paddingLeft: depth * 14 + 8 }}
      className={cn(
        "flex w-full items-center gap-2 py-1 pr-3 text-left text-sm",
        selectedPath === path
          ? "bg-[var(--color-accent)]"
          : "hover:bg-[var(--color-accent)]",
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
        <span
          className="shrink-0 text-xs font-bold"
          style={{ color }}
          title={status}
        >
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
    <div
      className="flex items-center gap-2 py-0.5 pr-3"
      style={{ paddingLeft: depth * 14 + 8 }}
    >
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

function Children(props: NodeProps) {
  const { repoId, parentPath, depth, pending, creating, onCreate, onCancelCreate } =
    props;
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
      body = entries.map((entry) => (
        <Entry key={entry.name} entry={entry} {...props} />
      ));
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
  changes,
}: {
  repoId: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  changes: TreeChanges;
}) {
  const queryClient = useQueryClient();
  // Expansion is lifted here so a create can force the target dir open and the
  // new entry becomes visible immediately.
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  // Path-keyed state, so drop it when switching repos to avoid carrying one
  // repo's open dirs / in-progress create into another.
  useEffect(() => {
    setOpenPaths(new Set());
    setMenu(null);
    setPending(null);
  }, [repoId]);

  const onToggle = useCallback((path: string) => {
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Where a create on the menu target should land.
  const targetDir = menu
    ? menu.kind === "dir"
      ? menu.path
      : parentDir(menu.path)
    : "";

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

  return (
    <>
      <Children
        repoId={repoId}
        parentPath=""
        depth={0}
        selectedPath={selectedPath}
        onSelect={onSelect}
        changes={changes}
        openPaths={openPaths}
        onToggle={onToggle}
        onContextMenu={setMenu}
        pending={pending}
        creating={busy}
        onCreate={submitCreate}
        onCancelCreate={() => setPending(null)}
      />

      <ContextMenu at={menu?.pos ?? null} onClose={() => setMenu(null)}>
        <ContextMenuItem className="text-xs" onClick={() => startCreate("file")}>
          <FilePlus />
          New File…
        </ContextMenuItem>
        <ContextMenuItem className="text-xs" onClick={() => startCreate("folder")}>
          <FolderPlus />
          New Folder…
        </ContextMenuItem>
        <div className="my-1 border-t border-[var(--color-border)]" />
        <ContextMenuItem
          className="text-xs"
          onClick={() => {
            const path = menu!.path;
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
            void copy(menu!.path, "Copied relative path");
            setMenu(null);
          }}
        >
          <LinkIcon />
          Copy Relative Path
        </ContextMenuItem>
      </ContextMenu>
    </>
  );
}
