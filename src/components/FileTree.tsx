import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";

import { fileIcon } from "@/lib/fileIcons";
import type { FileChange } from "@/lib/ipc";
import { cn } from "@/lib/utils";

interface FileNode {
  kind: "file";
  name: string;
  file: FileChange;
}
interface DirNode {
  kind: "dir";
  name: string;
  path: string;
  children: TreeNode[];
}
type TreeNode = FileNode | DirNode;

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

function buildTree(files: FileChange[]): TreeNode[] {
  const root: DirNode = { kind: "dir", name: "", path: "", children: [] };

  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const path = dir.path ? `${dir.path}/${seg}` : seg;
      let child = dir.children.find((c): c is DirNode => c.kind === "dir" && c.name === seg);
      if (!child) {
        child = { kind: "dir", name: seg, path, children: [] };
        dir.children.push(child);
      }
      dir = child;
    }
    dir.children.push({
      kind: "file",
      name: parts[parts.length - 1],
      file,
    });
  }

  sortDir(root);
  compact(root);
  return root.children;
}

function sortDir(dir: DirNode) {
  dir.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const c of dir.children) if (c.kind === "dir") sortDir(c);
}

// Collapse single-child directory chains (VSCode-style compact folders).
function compact(dir: DirNode) {
  for (const child of dir.children) {
    if (child.kind === "dir") {
      while (child.children.length === 1 && child.children[0].kind === "dir") {
        const only = child.children[0];
        child.name = `${child.name}/${only.name}`;
        child.path = only.path;
        child.children = only.children;
      }
      compact(child);
    }
  }
}

function FileRow({
  file,
  name,
  depth,
  selected,
  onOpen,
}: {
  file: FileChange;
  name: string;
  depth: number;
  selected: boolean;
  onOpen: (f: FileChange) => void;
}) {
  const Icon = fileIcon(name);
  return (
    <button
      onClick={() => onOpen(file)}
      title={file.path}
      style={{ paddingLeft: depth * 14 + 8 }}
      className={cn(
        "flex w-full items-center gap-2 py-1 pr-3 text-left text-sm",
        selected ? "bg-[var(--color-accent)]" : "hover:bg-[var(--color-accent)]",
      )}
    >
      <Icon className="size-4 shrink-0 text-[var(--color-muted-foreground)]" />
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{name}</span>
      <span
        className="shrink-0 text-xs font-bold"
        style={{ color: statusColor(file.status) }}
        title={file.status}
      >
        {file.status[0].toUpperCase()}
      </span>
      {file.additions > 0 && (
        <span className="shrink-0 text-xs font-medium text-[#16a34a]">+{file.additions}</span>
      )}
      {file.deletions > 0 && (
        <span className="shrink-0 text-xs font-medium text-[#dc2626]">−{file.deletions}</span>
      )}
    </button>
  );
}

function Nodes({
  nodes,
  depth,
  collapsed,
  toggle,
  selectedPath,
  onOpen,
}: {
  nodes: TreeNode[];
  depth: number;
  collapsed: Set<string>;
  toggle: (path: string) => void;
  selectedPath?: string | null;
  onOpen: (f: FileChange) => void;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === "dir" ? (
          <div key={`d:${node.path}`}>
            <button
              onClick={() => toggle(node.path)}
              style={{ paddingLeft: depth * 14 + 8 }}
              className="flex w-full items-center gap-1.5 py-1 pr-3 text-left text-sm hover:bg-[var(--color-accent)]"
            >
              {collapsed.has(node.path) ? (
                <ChevronRight className="size-3.5 shrink-0 text-[var(--color-muted-foreground)]" />
              ) : (
                <ChevronDown className="size-3.5 shrink-0 text-[var(--color-muted-foreground)]" />
              )}
              <Folder className="size-4 shrink-0 text-[var(--color-muted-foreground)]" />
              <span className="min-w-0 flex-1 truncate text-xs">{node.name}</span>
            </button>
            {!collapsed.has(node.path) && (
              <Nodes
                nodes={node.children}
                depth={depth + 1}
                collapsed={collapsed}
                toggle={toggle}
                selectedPath={selectedPath}
                onOpen={onOpen}
              />
            )}
          </div>
        ) : (
          <FileRow
            key={`f:${node.file.path}`}
            file={node.file}
            name={node.name}
            depth={depth}
            selected={selectedPath === node.file.path}
            onOpen={onOpen}
          />
        ),
      )}
    </>
  );
}

export function FileTree({
  files,
  onOpen,
  selectedPath,
}: {
  files: FileChange[];
  onOpen: (f: FileChange) => void;
  selectedPath?: string | null;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggle(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <Nodes
      nodes={tree}
      depth={0}
      collapsed={collapsed}
      toggle={toggle}
      selectedPath={selectedPath}
      onOpen={onOpen}
    />
  );
}
