import { useEffect, useMemo, useRef, useState } from "react";
import {
  Folder,
  FolderGit2,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useGroups, useRepos } from "@/features/repos/api";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { termTabLabel, useUiStore } from "@/store/ui";

/** Max repo results shown for a non-empty query (and recents when empty). */
const REPO_LIMIT = 8;

interface PaletteItem {
  key: string;
  category: string;
  icon: LucideIcon;
  label: string;
  /** Secondary text (repo path, terminal's group) shown dimmed beside the label. */
  sublabel?: string;
  run: () => void;
}

/**
 * Rank `query` (already lowercased) against an item's text. A match in the
 * primary text scores by its offset, so prefix matches sort first; a match only
 * in secondary text sorts after every primary match. Returns null for no match.
 */
function rank(query: string, primary: string, ...secondary: string[]): number | null {
  if (!query) return 0;
  const p = primary.toLowerCase().indexOf(query);
  if (p >= 0) return p;
  if (secondary.some((s) => s.toLowerCase().includes(query))) return 1000;
  return null;
}

/**
 * ⌘/Ctrl+K command palette — a fuzzy/substring fast-switcher over everything
 * navigable: repos, groups, and open terminal tabs. Empty query shows recently
 * opened repos. Self-mounted at the app root; reads its open state from the UI
 * store (issue #45).
 */
export function CommandPalette() {
  const open = useUiStore((s) => s.commandPaletteOpen);
  const setOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const setActiveRepo = useUiStore((s) => s.setActiveRepo);
  const setActiveGroup = useUiStore((s) => s.setActiveGroup);
  const setTerminalOpen = useUiStore((s) => s.setTerminalOpen);
  const selectTerminalTab = useUiStore((s) => s.selectTerminalTab);
  const terminals = useUiStore((s) => s.terminals);
  const activeGroupId = useUiStore((s) => s.activeGroupId);

  const repos = useRepos();
  const groups = useGroups();

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  const close = () => setOpen(false);

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();
    const repoList = repos.data ?? [];
    const groupList = groups.data ?? [];
    const groupName = new Map(groupList.map((g) => [g.id, g.name]));
    const defaultGroup = groupList.find((g) => g.is_default) ?? groupList[0];

    const out: PaletteItem[] = [];

    // Repos — search by name (path as secondary); empty query shows the most
    // recently opened, newest first.
    const matchedRepos = q
      ? repoList
          .map((r) => ({ r, score: rank(q, r.name, r.path) }))
          .filter((m): m is { r: (typeof repoList)[number]; score: number } => m.score !== null)
          .sort((a, b) => a.score - b.score || a.r.name.localeCompare(b.r.name))
          .map((m) => m.r)
      : [...repoList]
          .sort((a, b) => (b.last_opened ?? "").localeCompare(a.last_opened ?? ""))
          .filter((r) => r.last_opened !== null);
    for (const r of matchedRepos.slice(0, REPO_LIMIT)) {
      out.push({
        key: `repo:${r.id}`,
        category: q ? "Repos" : "Recent",
        icon: FolderGit2,
        label: r.name,
        sublabel: r.path,
        run: () => {
          // Setting the active repo alone switches the main view, but the repo
          // sidebar is scoped to a group — so reveal the repo there too by
          // switching to a group that contains it (its first group, or the
          // default group for ungrouped repos), unless the current group
          // already shows it. Mirrors the visibility rule in RepoSidebar.
          const shownHere =
            activeGroupId != null &&
            (r.group_ids.includes(activeGroupId) ||
              (r.group_ids.length === 0 && defaultGroup?.id === activeGroupId));
          if (!shownHere) {
            const target = r.group_ids[0] ?? defaultGroup?.id ?? null;
            if (target != null) setActiveGroup(target);
          }
          setActiveRepo(r.id);
          void ipc.touchRepo(r.id);
          close();
        },
      });
    }

    // Groups — folder-bound groups are still just groups (issue scoped
    // "folders" to these); show them all when the query is empty.
    const matchedGroups = groupList
      .map((g) => ({ g, score: rank(q, g.name) }))
      .filter((m): m is { g: (typeof groupList)[number]; score: number } => m.score !== null)
      .sort((a, b) => a.score - b.score || a.g.name.localeCompare(b.g.name));
    for (const { g } of matchedGroups) {
      out.push({
        key: `group:${g.id}`,
        category: "Groups",
        icon: Folder,
        label: g.name,
        run: () => {
          setActiveGroup(g.id);
          close();
        },
      });
    }

    // Open terminal tabs across every group, labelled by their group.
    for (const [gid, gt] of Object.entries(terminals)) {
      const groupId = Number(gid);
      for (const tab of gt.tabs) {
        const label = termTabLabel(tab);
        const gname = groupName.get(groupId) ?? "";
        if (rank(q, label, gname) === null) continue;
        out.push({
          key: `term:${groupId}:${tab.id}`,
          category: "Terminals",
          icon: SquareTerminal,
          label,
          sublabel: gname,
          run: () => {
            setActiveGroup(groupId);
            setTerminalOpen(true);
            selectTerminalTab(groupId, tab.id);
            close();
          },
        });
      }
    }

    return out;
    // `close` is omitted from deps on purpose — it only calls the stable
    // `setOpen` store action, so its identity never affects the result.
  }, [
    query,
    repos.data,
    groups.data,
    terminals,
    activeGroupId,
    setActiveRepo,
    setActiveGroup,
    setTerminalOpen,
    selectTerminalTab,
  ]);

  // Reset query + selection each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
    }
  }, [open]);

  // Keep the selection in range as the result list shrinks/grows.
  useEffect(() => {
    setSelected((s) => (items.length === 0 ? 0 : Math.min(s, items.length - 1)));
  }, [items.length]);

  // Scroll the active row into view as the selection moves with the keyboard.
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => (s + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => (s - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[selected]?.run();
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        // Sit near the top like a typical command palette, and drop the
        // default close button — the field owns the whole top edge.
        className="top-[12%] w-full max-w-xl translate-y-0 gap-0 overflow-hidden p-0 [&>button]:hidden"
        onOpenAutoFocus={(e) => {
          // Let our input grab focus rather than the first result row.
          e.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search repositories, groups, and open terminals by name.
        </DialogDescription>
        <div className="border-b p-2">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search repos, groups, terminals…"
            className="h-9 border-none shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-80 overflow-auto py-1">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-[var(--color-muted-foreground)]">
              {query.trim() ? "No matches." : "No recent repositories."}
            </p>
          ) : (
            items.map((item, i) => {
              const showHeader = i === 0 || items[i - 1].category !== item.category;
              const isActive = i === selected;
              const Icon = item.icon;
              return (
                <div key={item.key}>
                  {showHeader && (
                    <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
                      {item.category}
                    </div>
                  )}
                  <button
                    ref={isActive ? activeRef : undefined}
                    onClick={() => item.run()}
                    onMouseMove={() => setSelected(i)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
                      isActive
                        ? "bg-[var(--color-accent)]"
                        : "hover:bg-[var(--color-accent)]",
                    )}
                  >
                    <Icon className="size-4 shrink-0 text-[var(--color-muted-foreground)]" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.sublabel && (
                      <span className="min-w-0 max-w-[55%] shrink-0 truncate text-xs text-[var(--color-muted-foreground)]">
                        {item.sublabel}
                      </span>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
