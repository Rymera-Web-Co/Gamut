import { useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";

import { fileIcon } from "@/lib/fileIcons";
import type { DirEntry } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useDirChildren } from "./api";

function join(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

/** Changed working-tree paths: a file→status map plus the set of directories
 * that contain a change (so they can be flagged too). */
export interface TreeChanges {
  files: Map<string, string>;
  dirs: Set<string>;
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
}

function Entry({
  entry,
  ...props
}: NodeProps & { entry: DirEntry }) {
  const { repoId, parentPath, depth, selectedPath, onSelect, changes } = props;
  const path = join(parentPath, entry.name);
  const [open, setOpen] = useState(false);

  if (entry.kind === "dir") {
    const hasChanges = changes.dirs.has(path);
    return (
      <div>
        <button
          onClick={() => setOpen((o) => !o)}
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
        {open && (
          <Children
            repoId={repoId}
            parentPath={path}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
            changes={changes}
          />
        )}
      </div>
    );
  }

  const Icon = fileIcon(entry.name);
  const status = changes.files.get(path);
  const color = status ? statusColor(status) : undefined;
  return (
    <button
      onClick={() => onSelect(path)}
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

function Children(props: NodeProps) {
  const { repoId, parentPath, depth, selectedPath, onSelect, changes } = props;
  const { data, isLoading, isError } = useDirChildren(repoId, parentPath, true);

  const indent = { paddingLeft: depth * 14 + 22 } as const;
  if (isLoading) {
    return (
      <p style={indent} className="py-1 text-xs text-[var(--color-muted-foreground)]">
        Loading…
      </p>
    );
  }
  if (isError) {
    return (
      <p style={indent} className="py-1 text-xs text-[var(--color-destructive)]">
        Failed to load
      </p>
    );
  }
  const entries = data ?? [];
  if (entries.length === 0) {
    return (
      <p style={indent} className="py-1 text-xs italic text-[var(--color-muted-foreground)]">
        empty
      </p>
    );
  }
  return (
    <>
      {entries.map((entry) => (
        <Entry
          key={entry.name}
          entry={entry}
          repoId={repoId}
          parentPath={parentPath}
          depth={depth}
          selectedPath={selectedPath}
          onSelect={onSelect}
          changes={changes}
        />
      ))}
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
  return (
    <Children
      repoId={repoId}
      parentPath=""
      depth={0}
      selectedPath={selectedPath}
      onSelect={onSelect}
      changes={changes}
    />
  );
}
