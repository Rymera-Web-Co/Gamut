import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Repo } from "@/lib/ipc";

// The header derives everything it shows from the repos/groups/status queries
// and the sync mutations — stub the hooks so no QueryClient is needed.
const data = vi.hoisted(() => ({
  repos: [] as Repo[],
}));

vi.mock("@/features/repos/api", () => ({
  useRepos: () => ({ data: data.repos }),
  useGroups: () => ({ data: [] }),
  useRepoStatuses: () => ({ data: [] }),
}));
// The sync/branch widgets bring their own query stacks — stub them; this suite
// only cares whether the header renders them at all.
vi.mock("@/features/sync/SyncControls", () => ({
  SyncControls: () => <div data-testid="sync-controls" />,
}));
vi.mock("@/features/history/BranchSwitcher", () => ({
  BranchSwitcher: () => <div data-testid="branch-switcher" />,
}));

import { WorkspaceHeader } from "./WorkspaceHeader";
import { useUiStore } from "@/store/ui";

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

beforeEach(() => {
  data.repos = [];
  useUiStore.setState({
    view: "files",
    activeRepoId: null,
    activeGroupId: 1,
    repoSidebarHidden: true,
  });
});

describe("WorkspaceHeader", () => {
  it("shows the sidebar toggle and flips repoSidebarHidden", () => {
    render(<WorkspaceHeader />);
    const toggle = screen.getByLabelText("Show sidebar");
    fireEvent.click(toggle);
    expect(useUiStore.getState().repoSidebarHidden).toBe(false);
    fireEvent.click(screen.getByLabelText("Hide sidebar"));
    expect(useUiStore.getState().repoSidebarHidden).toBe(true);
  });

  it("renders no view tabs without an active repo", () => {
    render(<WorkspaceHeader />);
    expect(screen.getByText("No repository selected")).toBeTruthy();
    expect(screen.queryByText("Files")).toBeNull();
  });

  it("renders all view tabs plus sync/branch controls for a git repo and switches views", () => {
    data.repos = [repo(1, "alpha")];
    useUiStore.setState({ activeRepoId: 1 });
    render(<WorkspaceHeader />);

    for (const label of ["Files", "History", "Review", "Pull Requests"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByTestId("sync-controls")).toBeTruthy();
    expect(screen.getByTestId("branch-switcher")).toBeTruthy();
    fireEvent.click(screen.getByText("History"));
    expect(useUiStore.getState().view).toBe("history");
  });

  it("hides the git-only tabs and sync actions for a non-git folder", () => {
    data.repos = [repo(1, "docs", { is_git_repo: false })];
    useUiStore.setState({ activeRepoId: 1 });
    render(<WorkspaceHeader />);

    expect(screen.getByText("Files")).toBeTruthy();
    expect(screen.queryByText("History")).toBeNull();
    expect(screen.queryByTestId("sync-controls")).toBeNull();
    expect(screen.queryByTestId("branch-switcher")).toBeNull();
  });

  it("shows the repo breadcrumb name", () => {
    data.repos = [repo(7, "gamut-app")];
    useUiStore.setState({ activeRepoId: 7 });
    render(<WorkspaceHeader />);
    expect(screen.getByText("gamut-app")).toBeTruthy();
  });
});
