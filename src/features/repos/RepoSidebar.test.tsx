import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Group, Repo } from "@/lib/ipc";
import { useActiveRepoReconciler } from "@/lib/useActiveRepoReconciler";
import { useUiStore } from "@/store/ui";

// Every ipc entry point reachable from the mounted tree (RepoSidebar + its
// children: DiscoverDialog, GroupDialog, BranchSwitcher, ConfirmRemoveReposDialog).
// Most are never invoked in these tests (they sit behind buttons we don't click,
// or queries this suite keeps disabled) — they're stubbed so an accidental call
// fails loudly instead of throwing "not a function".
const mocks = vi.hoisted(() => ({
  listRepos: vi.fn(),
  listGroups: vi.fn(),
  removeRepos: vi.fn(),
  touchRepo: vi.fn(),
  repoRemoteUrl: vi.fn(),
  gitWorktreeList: vi.fn(),
  gitFetchMany: vi.fn(),
  gitPullMany: vi.fn(),
  gitPushMany: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  ipc: {
    listRepos: mocks.listRepos,
    listGroups: mocks.listGroups,
    repoStatuses: () => Promise.resolve([]),
    repoRemoteUrl: mocks.repoRemoteUrl,
    gitWorktreeList: mocks.gitWorktreeList,
    removeRepos: mocks.removeRepos,
    touchRepo: mocks.touchRepo,
    gitFetchMany: mocks.gitFetchMany,
    gitPullMany: mocks.gitPullMany,
    gitPushMany: mocks.gitPushMany,
    registerRepo: vi.fn(),
    reorderRepos: vi.fn(),
    setRepoGroups: vi.fn(),
    discoverRepos: vi.fn(),
    listBranches: vi.fn().mockResolvedValue([]),
    listGitTags: vi.fn().mockResolvedValue([]),
    checkoutBranch: vi.fn(),
    createBranch: vi.fn(),
    gitPull: vi.fn(),
    gitPush: vi.fn(),
    repoStatus: vi.fn(),
    setRepoAutoPull: vi.fn(),
  },
  pickDirectory: vi.fn(),
}));

import { RepoSidebar } from "./RepoSidebar";

function repo(id: number, name: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/repos/${name}`,
    name,
    default_branch: "main",
    last_opened: null,
    created_at: "",
    tag_ids: [],
    group_ids: [],
    missing: false,
    is_git_repo: true,
    has_worktrees: false,
    auto_pull: false,
    ...overrides,
  };
}

function group(id: number, name: string, overrides: Partial<Group> = {}): Group {
  return {
    id,
    name,
    parent_id: null,
    sort: id,
    icon: null,
    is_default: false,
    folder_path: null,
    last_scan_at: null,
    root_repo_id: null,
    ...overrides,
  };
}

/** Whether `el`'s class list contains the exact token `cls` (not just a
 * substring — `"opacity-0"` must not match `"group-hover:opacity-0"`). */
function hasClass(el: Element, cls: string): boolean {
  return el.className.split(/\s+/).includes(cls);
}

const DEFAULT_GROUP = group(1, "Default", { is_default: true });
const GROUPS = [DEFAULT_GROUP];

// Rendered order across the git-repos / Folders boundary is [A, B, C, D, E].
const A = repo(1, "alpha");
const B = repo(2, "beta");
const C = repo(3, "gamma", { missing: true });
const D = repo(4, "docs", { is_git_repo: false });
const E = repo(5, "assets", { is_git_repo: false });

function SidebarOnly() {
  return <RepoSidebar />;
}

function SidebarWithReconciler() {
  useActiveRepoReconciler();
  return <RepoSidebar />;
}

function renderSidebar(
  repos: Repo[],
  groups: Group[] = GROUPS,
  opts: { reconciler?: boolean } = {},
) {
  mocks.listRepos.mockResolvedValue(repos);
  mocks.listGroups.mockResolvedValue(groups);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Harness = opts.reconciler ? SidebarWithReconciler : SidebarOnly;
  render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>,
  );
  return qc;
}

function removeButton(row: HTMLElement) {
  return within(row).getByLabelText("Remove repository");
}

beforeEach(() => {
  mocks.listRepos.mockReset();
  mocks.listGroups.mockReset();
  mocks.removeRepos.mockReset().mockResolvedValue(undefined);
  mocks.touchRepo.mockReset().mockResolvedValue(undefined);
  mocks.repoRemoteUrl.mockReset().mockResolvedValue(null);
  mocks.gitWorktreeList.mockReset().mockResolvedValue([]);
  mocks.gitFetchMany.mockReset().mockResolvedValue([]);
  mocks.gitPullMany.mockReset().mockResolvedValue([]);
  mocks.gitPushMany.mockReset().mockResolvedValue([]);
  useUiStore.setState({
    activeGroupId: 1,
    activeRepoId: null,
    activeWorktreePath: null,
    settingsOpen: false,
    repoConfigRepoId: null,
  });
});

describe("RepoSidebar selection (#294)", () => {
  it("A1: toggles a row into and out of the selection on ⌘/Ctrl-click", async () => {
    renderSidebar([A, B]);
    const rowA = await screen.findByTitle(A.path);

    fireEvent.click(rowA, { ctrlKey: true });
    expect(rowA.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(rowA, { ctrlKey: true });
    expect(rowA.getAttribute("aria-selected")).toBe("false");
  });

  it("A2: ⇧-click selects the inclusive range from the anchor, in either direction", async () => {
    renderSidebar([A, B, C]);
    await screen.findByTitle(A.path);

    // Downward: anchor above the clicked row.
    fireEvent.click(screen.getByTitle(B.path));
    fireEvent.click(screen.getByTitle(C.path), { shiftKey: true });
    expect(screen.getByTitle(A.path).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByTitle(B.path).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTitle(C.path).getAttribute("aria-selected")).toBe("true");

    // Upward: anchor below the clicked row — same resulting inclusive range.
    fireEvent.click(screen.getByTitle(C.path)); // plain click: re-anchor, clear selection
    fireEvent.click(screen.getByTitle(B.path), { shiftKey: true });
    expect(screen.getByTitle(A.path).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByTitle(B.path).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTitle(C.path).getAttribute("aria-selected")).toBe("true");
  });

  it("A3: a ⇧-range spans the git-repos / Folders section boundary in visible order", async () => {
    renderSidebar([A, B, C, D, E]);
    await screen.findByTitle(A.path);

    fireEvent.click(screen.getByTitle(B.path));
    fireEvent.click(screen.getByTitle(E.path), { shiftKey: true });

    expect(screen.getByTitle(A.path).getAttribute("aria-selected")).toBe("false");
    for (const r of [B, C, D, E]) {
      expect(screen.getByTitle(r.path).getAttribute("aria-selected")).toBe("true");
    }
  });

  it("A4: a plain click clears the selection and activates only that repo", async () => {
    renderSidebar([A, B]);
    await screen.findByTitle(A.path);

    fireEvent.click(screen.getByTitle(A.path), { ctrlKey: true });
    fireEvent.click(screen.getByTitle(B.path), { ctrlKey: true });

    fireEvent.click(screen.getByTitle(B.path));
    expect(screen.getByTitle(A.path).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByTitle(B.path).getAttribute("aria-selected")).toBe("false");
    expect(useUiStore.getState().activeRepoId).toBe(B.id);
  });

  it("A5: clears the selection when the active group changes", async () => {
    const groups = [DEFAULT_GROUP, group(2, "Other")];
    const other = repo(7, "other-repo", { group_ids: [2] });
    renderSidebar([A, B, other], groups);
    await screen.findByTitle(A.path);

    fireEvent.click(screen.getByTitle(A.path), { ctrlKey: true });
    fireEvent.click(screen.getByTitle(B.path), { ctrlKey: true });
    expect(screen.getByTitle(A.path).getAttribute("aria-selected")).toBe("true");

    act(() => {
      useUiStore.setState({ activeGroupId: 2 });
    });
    await screen.findByTitle(other.path);

    act(() => {
      useUiStore.setState({ activeGroupId: 1 });
    });
    await screen.findByTitle(A.path);
    expect(screen.getByTitle(A.path).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByTitle(B.path).getAttribute("aria-selected")).toBe("false");
  });

  it("A6: drops ids that leave the visible set from the selection", async () => {
    const qc = renderSidebar([A, B, C, D, E]);
    await screen.findByTitle(A.path);

    fireEvent.click(screen.getByTitle(B.path), { ctrlKey: true });
    fireEvent.click(screen.getByTitle(C.path), { ctrlKey: true });
    expect(screen.getByTitle(B.path).getAttribute("aria-selected")).toBe("true");

    // C leaves the visible set (e.g. reassigned to another group).
    mocks.listRepos.mockResolvedValue([A, B, D, E]);
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["repos"] });
    });
    await waitFor(() => expect(screen.queryByTitle(C.path)).not.toBeInTheDocument());

    expect(screen.getByTitle(B.path).getAttribute("aria-selected")).toBe("true");

    // A bulk removal now targets only the surviving selection (B) — not the gone id.
    fireEvent.click(removeButton(screen.getByTitle(B.path)));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(B.name)).toBeInTheDocument();
    expect(within(dialog).queryByText(C.name)).not.toBeInTheDocument();
  });

  it("A7: a nested WorktreeRow is not selectable", async () => {
    const wtParent = repo(6, "wt-parent", { has_worktrees: true });
    mocks.gitWorktreeList.mockResolvedValue([
      {
        repo_id: wtParent.id,
        path: "/repos/wt-parent-wt",
        branch: "feature-x",
        head: "abc123",
        is_main: false,
        missing: false,
      },
    ]);
    renderSidebar([wtParent]);
    await screen.findByTitle(wtParent.path);
    const wtRow = await screen.findByTitle("/repos/wt-parent-wt");

    expect(wtRow.hasAttribute("aria-selected")).toBe(false);
    fireEvent.click(wtRow, { ctrlKey: true });
    expect(wtRow.hasAttribute("aria-selected")).toBe(false);
    // The parent repo row's selection is untouched too.
    expect(screen.getByTitle(wtParent.path).getAttribute("aria-selected")).toBe("false");
  });

  it("A8: the selected treatment is distinct from active, and a row can be both at once", async () => {
    renderSidebar([A, B]);
    await screen.findByTitle(A.path);

    // A: plain-click activates it, then ⌘-click also selects it.
    fireEvent.click(screen.getByTitle(A.path));
    fireEvent.click(screen.getByTitle(A.path), { ctrlKey: true });
    const rowA = screen.getByTitle(A.path);
    expect(rowA.getAttribute("aria-selected")).toBe("true");
    expect(hasClass(rowA, "border-l-[#2563eb]")).toBe(true);

    // Both signals survive together: the active background/border is not
    // displaced by the selection treatment (a ring, not a competing `bg-*`).
    expect(hasClass(rowA, "bg-[#2563eb]/15")).toBe(true);
    expect(hasClass(rowA, "ring-[var(--color-primary)]")).toBe(true);

    // B: selected but never activated — the selection ring without the active
    // treatment, so the two states stay tellable apart.
    fireEvent.click(screen.getByTitle(B.path), { ctrlKey: true });
    const rowB = screen.getByTitle(B.path);
    expect(rowB.getAttribute("aria-selected")).toBe("true");
    expect(hasClass(rowB, "border-l-[#2563eb]")).toBe(false);
    expect(hasClass(rowB, "bg-[#2563eb]/15")).toBe(false);
    expect(hasClass(rowB, "ring-[var(--color-primary)]")).toBe(true);
  });
});

describe("RepoSidebar hover checkbox (#294 st_908)", () => {
  // Scope note: jsdom evaluates no `:hover` and computes no layout, so the
  // "only shows on hover" and "no layout shift" halves of this requirement are
  // NOT verifiable here — they're on the manual checklist. What this test does
  // pin is the structure that makes them possible (both children absolutely
  // positioned in one fixed-size slot, so neither can affect layout) and the
  // selection half of the reveal, which is real state and fully asserted.
  it("A9: the checkbox shares the icon's fixed-size slot, and selection flips which one shows", async () => {
    renderSidebar([A, B]);
    const row = await screen.findByTitle(A.path);
    const checkbox = within(row).getByLabelText(`Select ${A.name}`) as HTMLInputElement;
    const slot = checkbox.parentElement!;

    // One fixed-size slot holding both the icon and the checkbox as siblings.
    expect(hasClass(slot, "relative")).toBe(true);
    expect(hasClass(slot, "size-4")).toBe(true);
    expect(slot.children).toHaveLength(2);
    const iconWrapper = slot.children[0] as HTMLElement;
    expect(iconWrapper).not.toBe(checkbox);
    expect(hasClass(iconWrapper, "absolute")).toBe(true);
    expect(hasClass(iconWrapper, "inset-0")).toBe(true);
    expect(hasClass(checkbox, "absolute")).toBe(true);
    expect(hasClass(checkbox, "inset-0")).toBe(true);

    // Unselected: hover-revealed only — checkbox hidden, icon shown.
    expect(hasClass(checkbox, "opacity-0")).toBe(true);
    expect(hasClass(checkbox, "group-hover:opacity-100")).toBe(true);
    expect(hasClass(iconWrapper, "opacity-0")).toBe(false);
    expect(hasClass(iconWrapper, "group-hover:opacity-0")).toBe(true);

    // Selected: checkbox visible, icon hidden — same slot, no layout shift.
    fireEvent.click(row, { ctrlKey: true });
    expect(hasClass(checkbox, "opacity-100")).toBe(true);
    expect(hasClass(iconWrapper, "opacity-0")).toBe(true);
  });

  it("A10: clicking the checkbox toggles selection without activating the repo", async () => {
    renderSidebar([A, B]);
    const row = await screen.findByTitle(B.path);
    const checkbox = within(row).getByLabelText(`Select ${B.name}`);

    fireEvent.click(checkbox);
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(useUiStore.getState().activeRepoId).toBeNull();

    fireEvent.click(checkbox);
    expect(row.getAttribute("aria-selected")).toBe("false");
  });
});

describe("RepoSidebar bulk action bar (#294)", () => {
  /** The header's normal (no-selection) controls. */
  function headerControls() {
    return {
      fetchAll: screen.queryByTitle("Fetch all repositories in this group (⌘⌥F)"),
      add: screen.queryByTitle("Add repository"),
      scan: screen.queryByTitle("Scan a folder for repositories"),
    };
  }

  it("A28: replaces the header with a bulk-action bar once a row is selected, and restores it on clear", async () => {
    renderSidebar([A, B, C]);
    await screen.findByTitle(A.path);

    // No selection: the normal header, no toolbar.
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(headerControls().fetchAll).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle(A.path), { ctrlKey: true });

    // Selection: the bar replaces the group name and its per-group controls.
    const bar = screen.getByRole("toolbar", { name: /bulk actions/i });
    expect(within(bar).getByText("1 selected")).toBeInTheDocument();
    expect(headerControls().fetchAll).not.toBeInTheDocument();
    expect(headerControls().add).not.toBeInTheDocument();
    expect(headerControls().scan).not.toBeInTheDocument();
    expect(screen.queryByText("Default")).not.toBeInTheDocument();

    fireEvent.click(within(bar).getByLabelText("Clear selection"));

    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(headerControls().fetchAll).toBeInTheDocument();
    expect(screen.getByTitle(A.path).getAttribute("aria-selected")).toBe("false");
  });

  it("A29: the bar's count tracks the selection", async () => {
    renderSidebar([A, B, C]);
    await screen.findByTitle(A.path);

    fireEvent.click(screen.getByTitle(A.path), { ctrlKey: true });
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle(C.path), { shiftKey: true });
    expect(screen.getByText("3 selected")).toBeInTheDocument();
  });

  it("A30: select-all is indeterminate while partial, then selects every visible row", async () => {
    renderSidebar([A, B, C, D, E]);
    await screen.findByTitle(A.path);

    fireEvent.click(screen.getByTitle(A.path), { ctrlKey: true });
    const toggle = screen.getByLabelText("Select all") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.indeterminate).toBe(true);

    fireEvent.click(toggle);
    // Every row on screen, including the non-git Folders section.
    for (const r of [A, B, C, D, E]) {
      expect(screen.getByTitle(r.path).getAttribute("aria-selected")).toBe("true");
    }
    const all = screen.getByLabelText("Deselect all") as HTMLInputElement;
    expect(all.checked).toBe(true);
    expect(all.indeterminate).toBe(false);

    // Toggling again deselects everything, so the bar goes away.
    fireEvent.click(all);
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("A31: Pull and Push act on only the syncable selection — never a missing or non-git folder", async () => {
    renderSidebar([A, B, C, D, E]);
    await screen.findByTitle(A.path);

    // A + B are healthy git repos; C is missing, D and E are plain folders.
    fireEvent.click(screen.getByLabelText(`Select ${A.name}`));
    fireEvent.click(screen.getByLabelText(`Select ${B.name}`));
    fireEvent.click(screen.getByLabelText(`Select ${C.name}`));
    fireEvent.click(screen.getByLabelText(`Select ${D.name}`));
    expect(screen.getByText("4 selected")).toBeInTheDocument();

    // The count in the label states what will actually run, not the selection size.
    fireEvent.click(screen.getByLabelText("Pull 2 selected"));
    await waitFor(() => expect(mocks.gitPullMany).toHaveBeenCalledTimes(1));
    expect(mocks.gitPullMany).toHaveBeenCalledWith([A.id, B.id]);

    fireEvent.click(screen.getByLabelText("Push 2 selected"));
    await waitFor(() => expect(mocks.gitPushMany).toHaveBeenCalledTimes(1));
    expect(mocks.gitPushMany).toHaveBeenCalledWith([A.id, B.id]);
  });

  it("A32: Pull and Push are disabled when nothing in the selection can be synced", async () => {
    renderSidebar([A, C, D]);
    await screen.findByTitle(A.path);

    fireEvent.click(screen.getByLabelText(`Select ${C.name}`)); // missing
    fireEvent.click(screen.getByLabelText(`Select ${D.name}`)); // non-git
    expect(screen.getByLabelText("Pull 0 selected")).toBeDisabled();
    expect(screen.getByLabelText("Push 0 selected")).toBeDisabled();
    expect(mocks.gitPullMany).not.toHaveBeenCalled();
    expect(mocks.gitPushMany).not.toHaveBeenCalled();
  });

  it("A34: the bar's actions carry no text label, so they fit a narrow sidebar", async () => {
    renderSidebar([A, B]);
    await screen.findByTitle(A.path);
    fireEvent.click(screen.getByTitle(A.path), { ctrlKey: true });

    const bar = screen.getByRole("toolbar", { name: /bulk actions/i });
    // Only the count reads as text; every action is icon-only, named for
    // assistive tech and tooltips through its accessible label.
    for (const label of [
      "Clear selection",
      "Pull 1 selected",
      "Push 1 selected",
      "Remove 1 selected",
    ]) {
      const btn = within(bar).getByLabelText(label);
      expect(btn.textContent).toBe("");
    }
    expect(within(bar).getByText("1 selected")).toBeInTheDocument();
  });

  it("A33: the bar's Remove opens the dialog for the whole selection", async () => {
    renderSidebar([A, B, C]);
    await screen.findByTitle(A.path);

    fireEvent.click(screen.getByTitle(A.path), { ctrlKey: true });
    fireEvent.click(screen.getByTitle(B.path), { ctrlKey: true });
    fireEvent.click(screen.getByLabelText("Remove 2 selected"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove 2" }));

    await waitFor(() => expect(mocks.removeRepos).toHaveBeenCalledTimes(1));
    expect(mocks.removeRepos).toHaveBeenCalledWith([A.id, B.id]);
    // The selection is consumed, so the bar goes back to the normal header.
    await waitFor(() => expect(screen.queryByRole("toolbar")).not.toBeInTheDocument());
  });
});

describe("RepoSidebar bulk remove with confirmation (#294)", () => {
  it("A11: the context-menu label is N-aware", async () => {
    renderSidebar([A, B, C]);
    await screen.findByTitle(A.path);

    fireEvent.contextMenu(screen.getByTitle(A.path));
    expect(await screen.findByRole("menuitem", { name: "Remove repo" })).toBeInTheDocument();

    fireEvent.click(screen.getByTitle(A.path), { ctrlKey: true });
    fireEvent.click(screen.getByTitle(B.path), { ctrlKey: true });
    fireEvent.click(screen.getByTitle(C.path), { ctrlKey: true });
    fireEvent.contextMenu(screen.getByTitle(B.path));
    expect(
      await screen.findByRole("menuitem", { name: "Remove 3 repository folders" }),
    ).toBeInTheDocument();
  });

  it("A12: the dialog lists every selected folder and flags the missing ones", async () => {
    renderSidebar([A, B, C, D, E]);
    await screen.findByTitle(A.path);

    fireEvent.click(screen.getByTitle(A.path), { ctrlKey: true });
    fireEvent.click(screen.getByTitle(C.path), { ctrlKey: true });
    fireEvent.click(removeButton(screen.getByTitle(A.path)));

    const dialog = await screen.findByRole("dialog");
    const rows = within(dialog).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // Each row names the folder *and* its path — repo names are folder-derived
    // and routinely duplicated, so the name alone wouldn't identify it.
    expect(within(rows[0]).getByText(A.name)).toBeInTheDocument();
    expect(within(rows[0]).getByText(A.path)).toBeInTheDocument();
    expect(within(rows[1]).getByText(C.name)).toBeInTheDocument();
    expect(within(dialog).queryByText(B.name)).not.toBeInTheDocument();

    // The missing marker lands on exactly the missing row (C), not on A.
    expect(within(rows[0]).queryByLabelText("Folder no longer exists")).not.toBeInTheDocument();
    expect(within(rows[1]).getByLabelText("Folder no longer exists")).toBeInTheDocument();
  });

  it("A13: cancelling the dialog removes nothing", async () => {
    renderSidebar([A, B]);
    await screen.findByTitle(A.path);

    fireEvent.click(removeButton(screen.getByTitle(A.path)));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mocks.removeRepos).not.toHaveBeenCalled();
  });

  it("A14: confirming calls the bulk IPC exactly once with all selected ids", async () => {
    renderSidebar([A, B, C, D, E]);
    await screen.findByTitle(A.path);

    fireEvent.click(screen.getByTitle(A.path), { ctrlKey: true });
    fireEvent.click(screen.getByTitle(B.path), { ctrlKey: true });
    fireEvent.click(screen.getByTitle(C.path), { ctrlKey: true });
    fireEvent.click(removeButton(screen.getByTitle(A.path)));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove 3" }));

    await waitFor(() => expect(mocks.removeRepos).toHaveBeenCalledTimes(1));
    expect(mocks.removeRepos).toHaveBeenCalledWith([A.id, B.id, C.id]);
  });

  it("A15: the trash icon targets the whole selection on a selected row, and only that row on an unselected one", async () => {
    renderSidebar([A, B, C]);
    await screen.findByTitle(A.path);

    fireEvent.click(screen.getByTitle(A.path), { ctrlKey: true });
    fireEvent.click(screen.getByTitle(B.path), { ctrlKey: true });

    fireEvent.click(removeButton(screen.getByTitle(A.path)));
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(A.name)).toBeInTheDocument();
    expect(within(dialog).getByText(B.name)).toBeInTheDocument();
    expect(within(dialog).queryByText(C.name)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(removeButton(screen.getByTitle(C.path)));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(C.name)).toBeInTheDocument();
    expect(within(dialog).queryByText(A.name)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(B.name)).not.toBeInTheDocument();
  });

  it("A16: states files on disk are not deleted, and calls out a selected root row", async () => {
    const groups = [DEFAULT_GROUP, group(2, "Bound", { root_repo_id: B.id })];
    renderSidebar([A, B, C], groups);
    await screen.findByTitle(A.path);

    fireEvent.click(removeButton(screen.getByTitle(A.path)));
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/your files on disk are not deleted/i)).toBeInTheDocument();
    expect(within(dialog).queryByText(/synced root folder/i)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(removeButton(screen.getByTitle(B.path)));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/synced root folder/i)).toBeInTheDocument();
  });

  // #294's critical invariant: it must be impossible to remove more than the
  // dialog listed. Both of these are ways the payload could drift from the list.
  it("A25: switching group while the dialog is open closes it instead of removing the old group's repos", async () => {
    const groups = [DEFAULT_GROUP, group(2, "Other")];
    const other = repo(7, "other-repo", { group_ids: [2] });
    renderSidebar([A, B, other], groups);
    await screen.findByTitle(A.path);

    fireEvent.click(screen.getByTitle(A.path), { ctrlKey: true });
    fireEvent.click(screen.getByTitle(B.path), { ctrlKey: true });
    fireEvent.click(removeButton(screen.getByTitle(A.path)));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    // The group shortcuts are a window keydown listener the dialog overlay
    // doesn't intercept, so this is reachable with the dialog open.
    act(() => {
      useUiStore.setState({ activeGroupId: 2 });
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mocks.removeRepos).not.toHaveBeenCalled();
  });

  it("A26: a repo list refetch while the dialog is open can't change what gets removed", async () => {
    const qc = renderSidebar([A, B, C]);
    await screen.findByTitle(A.path);

    fireEvent.click(screen.getByTitle(A.path), { ctrlKey: true });
    fireEvent.click(screen.getByTitle(B.path), { ctrlKey: true });
    fireEvent.click(removeButton(screen.getByTitle(A.path)));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);

    // B disappears from the list behind the open dialog. Wait for the refetch to
    // actually land — the sidebar row for B is gone (only sidebar rows carry a
    // `title`, so this can't match the dialog's own list) — otherwise the
    // assertions below would pass vacuously against an unrefreshed tree.
    mocks.listRepos.mockResolvedValue([A, C]);
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["repos"] });
    });
    await waitFor(() => expect(screen.queryByTitle(B.path)).not.toBeInTheDocument());

    // The dialog still shows exactly what the user was asked to confirm, and
    // confirming sends exactly that — no more, no less.
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
    expect(within(dialog).getByRole("button", { name: "Remove 2" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove 2" }));
    await waitFor(() => expect(mocks.removeRepos).toHaveBeenCalledTimes(1));
    expect(mocks.removeRepos).toHaveBeenCalledWith([A.id, B.id]);
  });

  it("A27: calls out the root row when a multi-selection contains one", async () => {
    const groups = [DEFAULT_GROUP, group(2, "Bound", { root_repo_id: B.id })];
    renderSidebar([A, B, C], groups);
    await screen.findByTitle(A.path);

    fireEvent.click(screen.getByTitle(A.path), { ctrlKey: true });
    fireEvent.click(screen.getByTitle(B.path), { ctrlKey: true });
    fireEvent.click(removeButton(screen.getByTitle(A.path)));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
    expect(within(dialog).getByText(/synced root folder/i)).toBeInTheDocument();
  });

  describe("repo settings entry points (#306 follow-up)", () => {
    it("the gear button opens the repo config dialog for that repo, without touching the active repo", async () => {
      renderSidebar([A, D]);
      const rowA = await screen.findByTitle(A.path);
      useUiStore.setState({ activeRepoId: B.id });

      fireEvent.click(within(rowA).getByLabelText(`Repo settings for ${A.name}`));

      expect(useUiStore.getState().repoConfigRepoId).toBe(A.id);
      expect(useUiStore.getState().activeRepoId).toBe(B.id);
    });

    it("does not render the gear button for a non-git folder row", async () => {
      renderSidebar([A, D]);
      const rowD = await screen.findByTitle(D.path);

      expect(within(rowD).queryByLabelText(`Repo settings for ${D.name}`)).not.toBeInTheDocument();
    });

    it("does not render the gear button for a missing repo row", async () => {
      renderSidebar([A, C]);
      const rowC = await screen.findByTitle(C.path);

      expect(within(rowC).queryByLabelText(`Repo settings for ${C.name}`)).not.toBeInTheDocument();
    });

    it("the context-menu item opens the repo config dialog for that repo, without touching the active repo", async () => {
      renderSidebar([A]);
      const rowA = await screen.findByTitle(A.path);
      useUiStore.setState({ activeRepoId: null });

      fireEvent.contextMenu(rowA);
      fireEvent.click(await screen.findByRole("menuitem", { name: "Repo settings…" }));

      expect(useUiStore.getState().repoConfigRepoId).toBe(A.id);
      expect(useUiStore.getState().activeRepoId).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Repo settings…" })).not.toBeInTheDocument();
    });

    it("does not render the context-menu item for a non-git folder", async () => {
      renderSidebar([A, D]);
      const rowD = await screen.findByTitle(D.path);

      fireEvent.contextMenu(rowD);
      await screen.findByRole("menuitem", { name: "Remove repo" });
      expect(screen.queryByRole("menuitem", { name: "Repo settings…" })).not.toBeInTheDocument();
    });
  });

  it("A17: reconciles the active repo when the removed selection includes it", async () => {
    let currentRepos: Repo[] = [A, B, C];
    mocks.listRepos.mockImplementation(() => Promise.resolve(currentRepos));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.listGroups.mockResolvedValue(GROUPS);
    render(
      <QueryClientProvider client={qc}>
        <SidebarWithReconciler />
      </QueryClientProvider>,
    );
    await screen.findByTitle(A.path);

    // Plain click activates A, then ⇧-click extends the selection to all three.
    fireEvent.click(screen.getByTitle(A.path));
    fireEvent.click(screen.getByTitle(C.path), { shiftKey: true });
    expect(useUiStore.getState().activeRepoId).toBe(A.id);

    fireEvent.click(removeButton(screen.getByTitle(A.path)));
    const dialog = await screen.findByRole("dialog");

    currentRepos = []; // the whole visible group is gone once the DELETE lands
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove 3" }));

    await waitFor(() => expect(mocks.removeRepos).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useUiStore.getState().activeRepoId).toBeNull());
    // The sidebar keeps rendering (no throw) and shows its empty state.
    expect(screen.getByText(/No repositories yet/)).toBeInTheDocument();
  });
});
