import { useEffect, useMemo, useRef, useState } from "react";
import { Folder, FolderGit2, SquareTerminal, type LucideIcon } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useGroups, useRepos } from "@/features/repos/api";
import { ActivityDot, groupActivityKind, tabActivityKind } from "@/features/terminal/activity";
import { repoInGroup } from "@/lib/groupRepos";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { ACTIVITY_PRIORITY, type TermActivityKind, termTabLabel, useUiStore } from "@/store/ui";

/** Max repo results shown for a non-empty query (and recents when empty). */
const REPO_LIMIT = 8;

/**
 * "Requesting action" is the salient subset of unseen activity (issue #84):
 * a rung bell or an exited process — never plain `output`, which is too noisy
 * to float to the top of the palette.
 */
function isAttention(kind: TermActivityKind | undefined): kind is "bell" | "exit" {
  return kind === "bell" || kind === "exit";
}

/**
 * Score subtracted from an attention item's text-match rank so it sorts above
 * non-attention matches of similar relevance while a query is active, ordered
 * by salience (exit before bell). A strong text match elsewhere can still win.
 */
function attentionBoost(kind: "bell" | "exit"): number {
  return 100 + ACTIVITY_PRIORITY[kind];
}

interface PaletteItem {
  key: string;
  category: string;
  icon: LucideIcon;
  label: string;
  /** Secondary text (repo path, terminal's group) shown dimmed beside the label. */
  sublabel?: string;
  /** Unseen-activity kind, set on "Needs attention" entries to show its dot. */
  activity?: TermActivityKind;
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
  const termActivity = useUiStore((s) => s.termActivity);
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

    // Navigation closures, shared so a "Needs attention" entry routes exactly
    // like the matching Group/Terminal entry does (revealing clears activity).
    const runGroup = (id: number) => () => {
      setActiveGroup(id);
      close();
    };
    const runTerminal = (groupId: number, tabId: string) => () => {
      setActiveGroup(groupId);
      setTerminalOpen(true);
      selectTerminalTab(groupId, tabId);
      close();
    };

    // "Needs attention" (issue #84): terminals whose hidden panes are requesting
    // action (bell/exit only — not plain output), plus the groups that contain
    // one. Most salient first (exit before bell). When the query is empty these
    // are pinned as a top section; with a query active they instead boost the
    // rank of their normal Group/Terminal rows (built below) so a strong text
    // match elsewhere can still sort first.
    interface Attn {
      item: PaletteItem;
      kind: "bell" | "exit";
    }
    const attention: Attn[] = [];
    for (const [gid, gt] of Object.entries(terminals)) {
      const groupId = Number(gid);
      const gname = groupName.get(groupId) ?? "";
      const gkind = groupActivityKind(gt, termActivity);
      if (isAttention(gkind)) {
        attention.push({
          kind: gkind,
          item: {
            key: `attn-group:${groupId}`,
            category: "Needs attention",
            icon: Folder,
            label: gname,
            activity: gkind,
            run: runGroup(groupId),
          },
        });
      }
      for (const tab of gt.tabs) {
        const tkind = tabActivityKind(tab, termActivity);
        if (!isAttention(tkind)) continue;
        attention.push({
          kind: tkind,
          item: {
            key: `attn-term:${groupId}:${tab.id}`,
            category: "Needs attention",
            icon: SquareTerminal,
            label: termTabLabel(tab),
            sublabel: gname,
            activity: tkind,
            run: runTerminal(groupId, tab.id),
          },
        });
      }
    }
    // Lookups for the query-active boost path: which terminals/groups are flagged.
    const groupAttn = new Map<number, "bell" | "exit">();
    const termAttn = new Map<string, "bell" | "exit">();
    for (const a of attention) {
      if (a.item.key.startsWith("attn-group:"))
        groupAttn.set(Number(a.item.key.split(":")[1]), a.kind);
      else termAttn.set(a.item.key.slice("attn-".length), a.kind);
    }

    // With an empty query, pin the attention section on top, ordered by salience
    // (exit before bell), then alphabetically for a stable order.
    if (!q) {
      attention
        .sort(
          (a, b) =>
            ACTIVITY_PRIORITY[b.kind] - ACTIVITY_PRIORITY[a.kind] ||
            a.item.label.localeCompare(b.item.label),
        )
        .forEach((a) => out.push(a.item));
    }

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
          const activeGroup = groupList.find((g) => g.id === activeGroupId);
          const shownHere = repoInGroup(r, activeGroup);
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
    // "folders" to these); show them all when the query is empty. When a query
    // is active, an attention-flagged group's score is boosted (see #84).
    const matchedGroups = groupList
      .map((g) => {
        const base = rank(q, g.name);
        if (base === null) return null;
        const kind = groupAttn.get(g.id);
        return { g, kind, score: q && kind ? base - attentionBoost(kind) : base };
      })
      .filter((m) => m !== null)
      .sort((a, b) => a.score - b.score || a.g.name.localeCompare(b.g.name));
    for (const { g, kind } of matchedGroups) {
      out.push({
        key: `group:${g.id}`,
        category: "Groups",
        icon: Folder,
        label: g.name,
        // With a query active there's no pinned section, so show why a boosted
        // group floated up. Empty-query groups never carry the dot here.
        activity: q ? kind : undefined,
        run: runGroup(g.id),
      });
    }

    // Open terminal tabs across every group, labelled by their group. With a
    // query active, attention-flagged tabs are scored with a boost (see #84).
    const matchedTerms = Object.entries(terminals)
      .flatMap(([gid, gt]) => {
        const groupId = Number(gid);
        const gname = groupName.get(groupId) ?? "";
        return gt.tabs.map((tab) => {
          const label = termTabLabel(tab);
          const base = rank(q, label, gname);
          if (base === null) return null;
          const kind = termAttn.get(`term:${groupId}:${tab.id}`);
          return {
            groupId,
            tab,
            label,
            gname,
            kind,
            score: q && kind ? base - attentionBoost(kind) : base,
          };
        });
      })
      .filter((m) => m !== null)
      .sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
    for (const { groupId, tab, label, gname, kind } of matchedTerms) {
      out.push({
        key: `term:${groupId}:${tab.id}`,
        category: "Terminals",
        icon: SquareTerminal,
        label,
        sublabel: gname,
        activity: q ? kind : undefined,
        run: runTerminal(groupId, tab.id),
      });
    }

    return out;
    // `close` is omitted from deps on purpose — it only calls the stable
    // `setOpen` store action, so its identity never affects the result.
  }, [
    query,
    repos.data,
    groups.data,
    terminals,
    termActivity,
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
            // Search queries are repo/group/terminal names (kebab-case, code
            // identifiers) — never dictionary words. Pass input through verbatim.
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            autoComplete="off"
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
                      isActive ? "bg-[var(--color-accent)]" : "hover:bg-[var(--color-accent)]",
                    )}
                  >
                    <Icon className="size-4 shrink-0 text-[var(--color-muted-foreground)]" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.activity && <ActivityDot kind={item.activity} />}
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
