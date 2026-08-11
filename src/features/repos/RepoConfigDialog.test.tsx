import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The panel's own behaviour (writes, refresh, the effective-config table) is
// covered by RepoConfigPanel.test.tsx; this suite proves only the dialog's
// own job — showing the right repo's name/path and wiring open/close to the
// store — mirroring how SettingsDialog.test.tsx stubs out its panels.
vi.mock("./RepoConfigPanel", () => ({
  RepoConfigPanel: ({ repoId }: { repoId: number }) => (
    <div data-testid="repo-config-panel-body">panel for {repoId}</div>
  ),
}));

const listRepos = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  ipc: { listRepos },
}));

import type { Repo } from "@/lib/ipc";
import { useUiStore } from "@/store/ui";
import { RepoConfigDialog } from "./RepoConfigDialog";

function repo(overrides?: Partial<Repo>): Repo {
  return {
    id: 1,
    path: "/Users/junix/code/gamut-app",
    name: "gamut-app",
    default_branch: "main",
    last_opened: null,
    created_at: "2024-01-01",
    tag_ids: [],
    group_ids: [],
    missing: false,
    is_git_repo: true,
    has_worktrees: false,
    auto_pull: false,
    ...overrides,
  };
}

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RepoConfigDialog />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listRepos.mockReset();
  useUiStore.setState({ repoConfigRepoId: null, activeRepoId: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RepoConfigDialog (#306 follow-up)", () => {
  it("renders nothing open when repoConfigRepoId is null", () => {
    listRepos.mockResolvedValue([repo()]);
    renderDialog();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the repo's name as the title and its path underneath, and renders the panel for it", async () => {
    listRepos.mockResolvedValue([repo({ id: 5, name: "widgets", path: "/home/me/widgets" })]);
    useUiStore.setState({ repoConfigRepoId: 5 });
    renderDialog();

    expect(await screen.findByRole("heading", { name: "widgets" })).toBeInTheDocument();
    expect(screen.getByText("/home/me/widgets")).toBeInTheDocument();
    expect(await screen.findByTestId("repo-config-panel-body")).toHaveTextContent("panel for 5");
  });

  it("does not change activeRepoId when it opens", async () => {
    listRepos.mockResolvedValue([repo({ id: 5 })]);
    useUiStore.setState({ repoConfigRepoId: 5, activeRepoId: 9 });
    renderDialog();

    await screen.findByRole("dialog");
    expect(useUiStore.getState().activeRepoId).toBe(9);
  });

  it("closing the dialog calls closeRepoConfig", async () => {
    listRepos.mockResolvedValue([repo({ id: 5 })]);
    useUiStore.setState({ repoConfigRepoId: 5 });
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: "Close" }));

    expect(useUiStore.getState().repoConfigRepoId).toBeNull();
  });

  it("guard: falls back to a generic title when the repo id no longer resolves", async () => {
    listRepos.mockResolvedValue([]);
    useUiStore.setState({ repoConfigRepoId: 5 });
    renderDialog();

    expect(await screen.findByRole("heading", { name: "Repo config" })).toBeInTheDocument();
    // The header must NOT also announce the repo is gone: the panel renders
    // that message (see RepoConfigPanel.test.tsx, which covers both the
    // removed-repo and not-a-git-repo cases), and showing it in both places
    // reads as two separate problems. The panel is stubbed in this suite, so
    // any occurrence here would have to have come from the header.
    expect(screen.queryByText("This repository is no longer available.")).not.toBeInTheDocument();
  });
});
