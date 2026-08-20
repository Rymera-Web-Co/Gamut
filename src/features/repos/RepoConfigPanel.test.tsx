import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Only the Tauri `invoke` boundary is faked — the real ipc wrappers, the real
// toast store, the real repos query, and the real panel all run for real, per
// the `DiagnosticsPanel.test.tsx` house pattern (#301, #306).
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {},
}));

// L5: `pickDirectory` (the "Browse…" folder picker) goes through the Tauri
// dialog plugin directly, not the `invoke` boundary above — faked the same
// way, at the same real-`ipc`-wrapper level, so the test drives the actual
// `pickDirectory` helper in `@/lib/ipc`.
const pickDirectoryDialog = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: pickDirectoryDialog,
  save: vi.fn(),
}));

import type { ConfigOverview, LinkedWorktree, Repo } from "@/lib/ipc";
import { useToasts } from "@/store/toast";
import { RepoConfigPanel } from "./RepoConfigPanel";

function baseRepo(overrides?: Partial<Repo>): Repo {
  return {
    id: 1,
    path: "/repo",
    name: "repo",
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

function baseOverview(overrides?: Partial<ConfigOverview>): ConfigOverview {
  return {
    entries: [{ name: "user.name", value: "Jane Doe", level: "local", effective: true }],
    identity: {
      name: { value: "Jane Doe", level: "local", local_value: "Jane Doe" },
      email: { value: "jane@example.com", level: "global", local_value: null },
    },
    remotes: [{ name: "origin", url: "https://user:tok@example.com/repo.git", push_url: null }],
    branches: [
      {
        name: "main",
        remote: "origin",
        merge: "refs/heads/main",
        is_head: true,
        ahead: 0,
        behind: 0,
        merged: true,
        protected: false,
      },
    ],
    remote_branches: ["origin/main"],
    ...overrides,
  };
}

function renderPanel(repoId = 1) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RepoConfigPanel repoId={repoId} />
    </QueryClientProvider>,
  );
}

/** Like `renderPanel`, but hands back the `QueryClient` too — for a test that
 * needs to spy on `invalidateQueries` (A24). */
function renderPanelWithClient(repoId = 1) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={qc}>
      <RepoConfigPanel repoId={repoId} />
    </QueryClientProvider>,
  );
  return { ...result, qc };
}

function baseWorktree(overrides?: Partial<LinkedWorktree>): LinkedWorktree {
  return {
    repo_id: 1,
    path: "/repo-worktree",
    branch: "feature",
    head: "abc123",
    is_main: false,
    missing: false,
    locked: false,
    prunable: false,
    // #326 LOW-1: the backend now decides this by canonicalizing paths — the
    // mocked backend controls it directly per test, rather than the panel
    // deriving it from the repos list.
    registered: false,
    ...overrides,
  };
}

/** Route `invoke` calls to fixed repos/overview/worktree fixtures, ignoring
 * writes (each returns `undefined`, i.e. success) unless the test overrides
 * it. `worktrees` defaults to none, matching the pre-#326 fixture shape. */
function mockBackend(repos: Repo[], overview: ConfigOverview, worktrees: LinkedWorktree[] = []) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "list_repos") return repos;
    if (cmd === "git_config_overview") return overview;
    if (cmd === "git_worktree_list") return worktrees;
    return undefined;
  });
}

beforeEach(() => {
  invoke.mockReset();
  pickDirectoryDialog.mockReset();
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RepoConfigPanel (#306)", () => {
  it("guard: renders a message and zero rows when repoId no longer resolves in the repo list", async () => {
    mockBackend([], baseOverview());
    renderPanel(1);

    expect(await screen.findByText("This repository is no longer available.")).toBeInTheDocument();
    expect(screen.queryAllByRole("row")).toHaveLength(0);
  });

  it("guard: renders the same message when the resolved repo is no longer a git repo", async () => {
    mockBackend([baseRepo({ id: 2, is_git_repo: false })], baseOverview());
    renderPanel(2);

    expect(await screen.findByText("This repository is no longer available.")).toBeInTheDocument();
    expect(screen.queryAllByRole("row")).toHaveLength(0);
  });

  it("A1: renders the Key/Value/Source table with one row per entry", async () => {
    mockBackend([baseRepo()], baseOverview());
    renderPanel(1);

    await screen.findByText("Effective config");
    expect(screen.getByRole("columnheader", { name: "Key" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Value" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Source" })).toBeInTheDocument();
    expect(screen.getByText("user.name")).toBeInTheDocument();
  });

  it("A3: a key set at two layers renders two rows, exactly one marked effective", async () => {
    mockBackend(
      [baseRepo()],
      baseOverview({
        entries: [
          { name: "user.email", value: "global@example.com", level: "global", effective: false },
          { name: "user.email", value: "local@example.com", level: "local", effective: true },
        ],
      }),
    );
    renderPanel(1);

    await screen.findByText("Effective config");
    const rows = screen.getAllByText("user.email").map((el) => el.closest("tr")!);
    expect(rows).toHaveLength(2);
    const markedCurrent = rows.filter((r) => within(r).queryByText("current"));
    expect(markedCurrent).toHaveLength(1);
    expect(within(markedCurrent[0]).getByText("local@example.com")).toBeInTheDocument();
  });

  it("A6: a non-UTF-8 entry renders a placeholder and other rows still render", async () => {
    mockBackend(
      [baseRepo()],
      baseOverview({
        entries: [
          { name: "weird.val", value: null, level: "local", effective: true },
          { name: "user.name", value: "Jane Doe", level: "local", effective: true },
        ],
      }),
    );
    renderPanel(1);

    await screen.findByText("Effective config");
    expect(screen.getByText("(non-UTF-8 value)")).toBeInTheDocument();
    expect(screen.getByText("user.name")).toBeInTheDocument();
  });

  it("A8: Refresh re-reads from disk and shows the new value", async () => {
    let overview = baseOverview({
      entries: [{ name: "user.name", value: "Old Name", level: "local", effective: true }],
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_repos") return [baseRepo()];
      if (cmd === "git_config_overview") return overview;
      return undefined;
    });
    renderPanel(1);

    await screen.findByText("Old Name");

    overview = baseOverview({
      entries: [
        { name: "user.name", value: "Externally Changed", level: "local", effective: true },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("Externally Changed")).toBeInTheDocument();
  });

  it("A9/A20: the editable-control set is exactly identity, one URL field per remote, the branch/upstream pickers, and the new-branch/add-worktree form controls", async () => {
    mockBackend(
      [baseRepo()],
      baseOverview({
        remotes: [
          { name: "origin", url: "https://example.com/a.git", push_url: null },
          { name: "upstream", url: "https://example.com/b.git", push_url: null },
        ],
      }),
    );
    const { container } = renderPanel(1);

    await screen.findByText("Effective config");
    // Radix's Select trigger is a `<button role="combobox">`, not a native
    // `<select>` — included alongside the native form controls so this stays
    // an enumeration of every editable control regardless of which markup
    // backs it (#306 follow-up: native `<select>` replaced with Radix Select).
    const controls = Array.from(
      container.querySelectorAll("input, textarea, [contenteditable], [role='combobox']"),
    );
    const names = controls.map((el) => el.getAttribute("aria-label"));
    expect(new Set(names)).toEqual(
      new Set([
        "user.name",
        "user.email",
        "origin URL",
        "upstream URL",
        "Branch",
        "Upstream",
        // #326: the "New branch…" form (Branches section) and the "Add
        // worktree…" form (Worktrees section) — both always rendered, not
        // gated behind an extra click, so their controls are always present.
        "New branch name",
        "Base branch",
        "Worktree path",
        "Worktree branch",
      ]),
    );
    expect(names).toHaveLength(10);
  });

  it("A10: changing the repoId prop re-reads and discards an unsaved edit from the previous repo", async () => {
    const overview1 = baseOverview({
      identity: {
        name: { value: "Repo One Name", level: "local", local_value: "Repo One Name" },
        email: { value: null, level: null, local_value: null },
      },
    });
    const overview2 = baseOverview({
      identity: {
        name: { value: "Repo Two Name", level: "local", local_value: "Repo Two Name" },
        email: { value: null, level: null, local_value: null },
      },
    });
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_repos") return [baseRepo({ id: 1 }), baseRepo({ id: 2 })];
      if (cmd === "git_config_overview") {
        return args?.repoId === 2 ? overview2 : overview1;
      }
      return undefined;
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <RepoConfigPanel repoId={1} />
      </QueryClientProvider>,
    );
    const nameInput = await screen.findByRole("textbox", { name: "user.name" });
    expect(nameInput).toHaveValue("Repo One Name");

    // An uncommitted (not blurred) edit for repo 1...
    fireEvent.change(nameInput, { target: { value: "Uncommitted Draft" } });

    // ...switching repos must discard it, not apply it to repo 2.
    rerender(
      <QueryClientProvider client={qc}>
        <RepoConfigPanel repoId={2} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(nameInput).toHaveValue("Repo Two Name"));
    expect(screen.queryByDisplayValue("Uncommitted Draft")).not.toBeInTheDocument();
  });

  it("A15: the remote URL editor shows the unredacted value and round-trips an edit byte-identically", async () => {
    const credentialUrl = "https://user:tok@example.com/repo.git";
    mockBackend(
      [baseRepo()],
      baseOverview({ remotes: [{ name: "origin", url: credentialUrl, push_url: null }] }),
    );
    renderPanel(1);

    const urlInput = await screen.findByRole("textbox", { name: "origin URL" });
    expect(urlInput).toHaveValue(credentialUrl);

    // Fix 1: blurring without ever editing the field must not resave the
    // untouched, credential-bearing URL.
    fireEvent.blur(urlInput);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoke).not.toHaveBeenCalledWith("git_config_set_remote_url", expect.anything());

    // An actual edit still round-trips byte-identically, unredacted.
    const newCredentialUrl = "https://user:newtok@example.com/repo.git";
    fireEvent.change(urlInput, { target: { value: newCredentialUrl } });
    fireEvent.blur(urlInput);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "git_config_set_remote_url",
        expect.objectContaining({ repoId: 1, remote: "origin", url: newCredentialUrl }),
      ),
    );
  });

  it("fix 1: blurring an inherited (non-local) email without editing it does not write", async () => {
    mockBackend([baseRepo()], baseOverview());
    renderPanel(1);

    const emailInput = await screen.findByRole("textbox", { name: "user.email" });
    expect(emailInput).toHaveValue("jane@example.com");

    fireEvent.focus(emailInput);
    fireEvent.blur(emailInput);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoke).not.toHaveBeenCalledWith("git_config_set_identity", expect.anything());
  });

  it("fix 1: blurring an unmodified remote URL does not write", async () => {
    mockBackend(
      [baseRepo()],
      baseOverview({
        remotes: [{ name: "origin", url: "https://example.com/a.git", push_url: null }],
      }),
    );
    renderPanel(1);

    const urlInput = await screen.findByRole("textbox", { name: "origin URL" });
    fireEvent.focus(urlInput);
    fireEvent.blur(urlInput);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoke).not.toHaveBeenCalledWith("git_config_set_remote_url", expect.anything());
  });

  it("fix 8: a value with surrounding whitespace is trimmed before being sent", async () => {
    mockBackend([baseRepo()], baseOverview());
    renderPanel(1);

    const emailInput = await screen.findByRole("textbox", { name: "user.email" });
    fireEvent.change(emailInput, { target: { value: "new@example.com " } });
    fireEvent.blur(emailInput);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "git_config_set_identity",
        expect.objectContaining({ field: "email", value: "new@example.com" }),
      ),
    );
  });

  it("fix 15: Refresh is disabled while a load is in flight", async () => {
    const pending: { resolve: ((ov: ConfigOverview) => void) | null } = { resolve: null };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_repos") return [baseRepo()];
      if (cmd === "git_config_overview") {
        return new Promise<ConfigOverview>((resolve) => {
          pending.resolve = resolve;
        });
      }
      return undefined;
    });
    renderPanel(1);

    const refreshButton = await screen.findByRole("button", { name: "Refresh" });
    await waitFor(() => expect(refreshButton).toBeDisabled());

    act(() => {
      pending.resolve?.(baseOverview());
    });
    await waitFor(() => expect(refreshButton).not.toBeDisabled());
  });

  it("fix 16: the effective-config table exposes an accessible name and column headers", async () => {
    mockBackend([baseRepo()], baseOverview());
    renderPanel(1);

    await screen.findByText("Effective config");
    const table = screen.getByRole("table", { name: "Effective git config entries" });
    for (const header of within(table).getAllByRole("columnheader")) {
      expect(header).toHaveAttribute("scope", "col");
    }
  });

  it("the config table scrolls sideways instead of wrapping long values", async () => {
    // Config values are routinely wider than the dialog. Wrapping them turns a
    // single entry into a multi-line row and buries the rest of the table, so
    // the table sits in a horizontal scroller and its cells never wrap.
    mockBackend(
      [baseRepo()],
      baseOverview({
        entries: [
          {
            name: "remote.origin.fetch",
            value: "+refs/heads/*:refs/remotes/origin/*",
            level: "local",
            effective: true,
          },
        ],
      }),
    );
    renderPanel(1);

    await screen.findByText("Effective config");
    const table = screen.getByRole("table", { name: "Effective git config entries" });

    const scroller = table.parentElement!;
    expect(scroller).toHaveClass("overflow-x-auto");
    // Focusable, or a keyboard user cannot reach the clipped columns at all.
    expect(scroller).toHaveAttribute("tabindex", "0");
    // The table must be free to exceed the scroller's width, not be squeezed
    // back into it — `w-full` alone would just re-introduce wrapping.
    expect(table).toHaveClass("w-max");

    for (const cell of within(table).getAllByRole("cell")) {
      expect(cell).toHaveClass("whitespace-nowrap");
    }
  });

  it("fix 7: a remote with a distinct push URL renders a read-only note; one without does not", async () => {
    mockBackend(
      [baseRepo()],
      baseOverview({
        remotes: [
          {
            name: "origin",
            url: "https://example.com/a.git",
            push_url: "https://example.com/push.git",
          },
          { name: "upstream", url: "https://example.com/b.git", push_url: null },
        ],
      }),
    );
    renderPanel(1);

    await screen.findByText("Effective config");
    expect(screen.getByText("https://example.com/push.git", { exact: false })).toBeInTheDocument();
    expect(screen.getAllByText(/not edited here/i)).toHaveLength(1);
  });

  it("fix 3: a stale response for a previous repo is dropped after switching repos (generation guard)", async () => {
    let resolveA: ((ov: ConfigOverview) => void) | null = null;
    const overviewA = baseOverview({
      identity: {
        name: { value: "Repo A Name", level: "local", local_value: "Repo A Name" },
        email: { value: null, level: null, local_value: null },
      },
    });
    const overviewB = baseOverview({
      identity: {
        name: { value: "Repo B Name", level: "local", local_value: "Repo B Name" },
        email: { value: null, level: null, local_value: null },
      },
    });

    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_repos") return [baseRepo({ id: 1 }), baseRepo({ id: 2 })];
      if (cmd === "git_config_overview") {
        if (args?.repoId === 1) {
          return new Promise<ConfigOverview>((resolve) => {
            resolveA = resolve;
          });
        }
        return overviewB;
      }
      return undefined;
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <RepoConfigPanel repoId={1} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(resolveA).not.toBeNull());

    // Switch to repo 2 before repo 1's (slow) response ever lands.
    rerender(
      <QueryClientProvider client={qc}>
        <RepoConfigPanel repoId={2} />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "user.name" })).toHaveValue("Repo B Name"),
    );

    // Now let repo A's stale response land late.
    act(() => {
      resolveA?.(overviewA);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByRole("textbox", { name: "user.name" })).toHaveValue("Repo B Name");
    expect(screen.queryByDisplayValue("Repo A Name")).not.toBeInTheDocument();
  });

  it("fix 9: an in-progress edit in a second field survives a write triggered by the first", async () => {
    let overview = baseOverview({
      identity: {
        name: { value: "Old Name", level: "global", local_value: null },
        email: { value: "jane@example.com", level: "global", local_value: null },
      },
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_repos") return [baseRepo()];
      if (cmd === "git_config_overview") return overview;
      if (cmd === "git_config_set_identity") {
        overview = baseOverview({
          identity: {
            name: { value: "New Name", level: "local", local_value: "New Name" },
            email: { value: "jane@example.com", level: "global", local_value: null },
          },
        });
        return undefined;
      }
      return undefined;
    });

    renderPanel(1);
    const nameInput = await screen.findByRole("textbox", { name: "user.name" });
    const emailInput = screen.getByRole("textbox", { name: "user.email" });

    // Commit Name (triggers an async write + refresh)...
    fireEvent.change(nameInput, { target: { value: "New Name" } });
    fireEvent.blur(nameInput);

    // ...and, before that refresh resolves, tab into Email and start typing.
    emailInput.focus();
    fireEvent.change(emailInput, { target: { value: "still.typing@ex" } });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "git_config_set_identity",
        expect.objectContaining({ field: "name" }),
      ),
    );
    // Give the post-write refresh a chance to land.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(emailInput).toHaveValue("still.typing@ex");
  });

  it("A23: the branch picker targets the selected (non-HEAD) branch, not a hardcoded HEAD", async () => {
    mockBackend(
      [baseRepo()],
      baseOverview({
        remotes: [
          { name: "origin", url: "https://example.com/a.git", push_url: null },
          { name: "upstream", url: "https://example.com/b.git", push_url: null },
        ],
        branches: [
          {
            name: "main",
            remote: "origin",
            merge: "refs/heads/main",
            is_head: true,
            ahead: 0,
            behind: 0,
            merged: true,
            protected: false,
          },
          {
            name: "second",
            remote: null,
            merge: null,
            is_head: false,
            ahead: null,
            behind: null,
            merged: false,
            protected: false,
          },
        ],
        remote_branches: ["origin/main", "upstream/main"],
      }),
    );
    renderPanel(1);

    const branchTrigger = await screen.findByRole("combobox", { name: "Branch" });
    expect(screen.getByRole("textbox", { name: "origin URL" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "upstream URL" })).toBeInTheDocument();

    // Radix Select isn't a native `<select>` — drive it by opening the
    // trigger and clicking the option, rather than `fireEvent.change`.
    fireEvent.click(branchTrigger);
    fireEvent.click(await screen.findByRole("option", { name: "second" }));

    const upstreamTrigger = screen.getByRole("combobox", { name: "Upstream" });
    fireEvent.click(upstreamTrigger);
    fireEvent.click(await screen.findByRole("option", { name: "upstream/main" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "git_config_set_branch_upstream",
        expect.objectContaining({ repoId: 1, branch: "second", upstream: "upstream/main" }),
      ),
    );
  });

  it("A24: a successful write shows the new value with source local, with no manual refresh", async () => {
    let overview = baseOverview({
      entries: [{ name: "user.name", value: "Old Name", level: "global", effective: true }],
      identity: {
        name: { value: "Old Name", level: "global", local_value: null },
        email: { value: null, level: null, local_value: null },
      },
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_repos") return [baseRepo()];
      if (cmd === "git_config_overview") return overview;
      if (cmd === "git_config_set_identity") {
        overview = baseOverview({
          entries: [{ name: "user.name", value: "New Name", level: "local", effective: true }],
          identity: {
            name: { value: "New Name", level: "local", local_value: "New Name" },
            email: { value: null, level: null, local_value: null },
          },
        });
        return undefined;
      }
      return undefined;
    });

    renderPanel(1);
    const nameInput = await screen.findByRole("textbox", { name: "user.name" });
    expect(nameInput).toHaveValue("Old Name");

    fireEvent.change(nameInput, { target: { value: "New Name" } });
    fireEvent.blur(nameInput);

    await waitFor(() => expect(screen.getByText("New Name")).toBeInTheDocument());
    const row = screen.getByText("New Name").closest("tr")!;
    expect(within(row).getByText("local")).toBeInTheDocument();
  });

  it("A25: a failed write surfaces an error toast and reverts the field", async () => {
    mockBackend([baseRepo()], baseOverview());
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_repos") return [baseRepo()];
      if (cmd === "git_config_overview") return baseOverview();
      if (cmd === "git_config_set_identity") throw new Error("rejected");
      return undefined;
    });
    renderPanel(1);

    const nameInput = await screen.findByRole("textbox", { name: "user.name" });
    expect(nameInput).toHaveValue("Jane Doe");

    fireEvent.change(nameInput, { target: { value: "Attempted Name" } });
    fireEvent.blur(nameInput);

    await waitFor(() =>
      expect(useToasts.getState().toasts.some((t) => t.variant === "error")).toBe(true),
    );
    await waitFor(() => expect(nameInput).toHaveValue("Jane Doe"));
    // The table still shows the old value, never the failed one.
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    expect(screen.queryByText("Attempted Name")).not.toBeInTheDocument();
  });

  // ---- #326: Branches + Worktrees sections ---------------------------------

  it("A1 (#326): renders a Branches section listing every local branch, with the current branch visibly marked", async () => {
    mockBackend(
      [baseRepo()],
      baseOverview({
        branches: [
          {
            name: "main",
            remote: "origin",
            merge: "refs/heads/main",
            is_head: true,
            ahead: 0,
            behind: 0,
            merged: true,
            protected: false,
          },
          {
            name: "feature-a",
            remote: null,
            merge: null,
            is_head: false,
            ahead: null,
            behind: null,
            merged: false,
            protected: false,
          },
          {
            name: "feature-b",
            remote: null,
            merge: null,
            is_head: false,
            ahead: null,
            behind: null,
            merged: true,
            protected: false,
          },
        ],
      }),
    );
    renderPanel(1);

    await screen.findByText("Branches");
    // Scoped to the Branches table: branch names are also mirrored as
    // `<option>`s inside Radix Select's hidden native `<select>` (the "Base
    // branch"/"Worktree branch" pickers), so an unscoped `getByText` matches
    // more than one element.
    const table = screen.getByRole("table", { name: "Branches" });
    expect(within(table).getByText("feature-a")).toBeInTheDocument();
    expect(within(table).getByText("feature-b")).toBeInTheDocument();
    const mainRow = within(table).getByText("main").closest("tr")!;
    expect(within(mainRow).getByText("current")).toBeInTheDocument();
    const featureRow = within(table).getByText("feature-a").closest("tr")!;
    expect(within(featureRow).queryByText("current")).not.toBeInTheDocument();
  });

  it("A2: each branch row shows its upstream (or none) and ahead/behind counts", async () => {
    mockBackend(
      [baseRepo()],
      baseOverview({
        branches: [
          {
            name: "main",
            remote: "origin",
            merge: "refs/heads/main",
            is_head: true,
            ahead: 0,
            behind: 0,
            merged: true,
            protected: false,
          },
          {
            name: "topic",
            remote: "origin",
            merge: "refs/heads/topic",
            is_head: false,
            ahead: 2,
            behind: 1,
            merged: false,
            protected: false,
          },
          {
            name: "local-only",
            remote: null,
            merge: null,
            is_head: false,
            ahead: null,
            behind: null,
            merged: false,
            protected: false,
          },
        ],
        remote_branches: ["origin/main", "origin/topic"],
      }),
    );
    renderPanel(1);

    await screen.findByText("Branches");
    const table = screen.getByRole("table", { name: "Branches" });
    const topicRow = within(table).getByText("topic").closest("tr")!;
    expect(within(topicRow).getByText("origin/topic")).toBeInTheDocument();
    expect(within(topicRow).getByText("+2 / -1")).toBeInTheDocument();
    const localRow = within(table).getByText("local-only").closest("tr")!;
    expect(within(localRow).getByText("none")).toBeInTheDocument();
  });

  it("A3: New branch creates from the selected base with an optional switch toggle; default base is the current branch", async () => {
    mockBackend(
      [baseRepo()],
      baseOverview({
        branches: [
          {
            name: "main",
            remote: null,
            merge: null,
            is_head: true,
            ahead: null,
            behind: null,
            merged: true,
            protected: false,
          },
          {
            name: "other",
            remote: null,
            merge: null,
            is_head: false,
            ahead: null,
            behind: null,
            merged: true,
            protected: false,
          },
        ],
      }),
    );
    renderPanel(1);

    const branchCreateCalls = () =>
      invoke.mock.calls.filter((c) => c[0] === "git_branch_create").length;

    const nameInput = await screen.findByRole("textbox", { name: "New branch name" });
    fireEvent.change(nameInput, { target: { value: "brand-new" } });

    // HIGH-1: clicking the "Switch to it" toggle inside the form must not
    // itself submit it (the toggle `<button>` needs `type="button"`, or a
    // native form would treat it as a submit control).
    fireEvent.click(screen.getByRole("switch"));
    expect(branchCreateCalls()).toBe(0);
    // Toggling back off so the first submit below exercises `switch: false`
    // as originally written.
    fireEvent.click(screen.getByRole("switch"));

    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "git_branch_create",
        expect.objectContaining({
          repoId: 1,
          name: "brand-new",
          fromRef: "main",
          switch: false,
        }),
      ),
    );
    expect(branchCreateCalls()).toBe(1);

    fireEvent.change(nameInput, { target: { value: "brand-new-2" } });
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "git_branch_create",
        expect.objectContaining({ name: "brand-new-2", switch: true }),
      ),
    );
  });

  it("A4: switching to a branch surfaces a toast on refusal and leaves the panel usable", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_repos") return [baseRepo()];
      if (cmd === "git_config_overview")
        return baseOverview({
          branches: [
            {
              name: "main",
              remote: null,
              merge: null,
              is_head: true,
              ahead: null,
              behind: null,
              merged: true,
              protected: false,
            },
            {
              name: "other",
              remote: null,
              merge: null,
              is_head: false,
              ahead: null,
              behind: null,
              merged: true,
              protected: false,
            },
          ],
        });
      if (cmd === "git_worktree_list") return [];
      if (cmd === "checkout_branch") throw new Error("local changes would be overwritten");
      return undefined;
    });
    renderPanel(1);

    await screen.findByText("Branches");
    const table = screen.getByRole("table", { name: "Branches" });
    const otherRow = within(table).getByText("other").closest("tr")!;
    fireEvent.click(within(otherRow).getByRole("button", { name: "Switch to branch other" }));

    await waitFor(() =>
      expect(useToasts.getState().toasts.some((t) => t.variant === "error")).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Refresh" })).not.toBeDisabled();
  });

  it("A5/A10: renaming a branch sends the payload and refetches the overview", async () => {
    mockBackend(
      [baseRepo()],
      baseOverview({
        branches: [
          {
            name: "main",
            remote: null,
            merge: null,
            is_head: true,
            ahead: null,
            behind: null,
            merged: true,
            protected: false,
          },
          {
            name: "old-name",
            remote: null,
            merge: null,
            is_head: false,
            ahead: null,
            behind: null,
            merged: true,
            protected: false,
          },
        ],
      }),
    );
    renderPanel(1);

    await screen.findByText("Branches");
    const table = screen.getByRole("table", { name: "Branches" });
    const row = within(table).getByText("old-name").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Rename branch old-name" }));

    const renameInput = screen.getByRole("textbox", { name: "Rename old-name" });
    fireEvent.change(renameInput, { target: { value: "new-name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "rename_branch",
        expect.objectContaining({ repoId: 1, name: "old-name", newName: "new-name" }),
      ),
    );
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter((c) => c[0] === "git_config_overview").length,
      ).toBeGreaterThan(1),
    );
  });

  it("A6: deleting a merged branch requires one confirmation and sends force=false", async () => {
    mockBackend(
      [baseRepo()],
      baseOverview({
        branches: [
          {
            name: "main",
            remote: null,
            merge: null,
            is_head: true,
            ahead: null,
            behind: null,
            merged: true,
            protected: false,
          },
          {
            name: "merged-feature",
            remote: null,
            merge: null,
            is_head: false,
            ahead: null,
            behind: null,
            merged: true,
            protected: false,
          },
        ],
      }),
    );
    renderPanel(1);

    await screen.findByText("Branches");
    const table = screen.getByRole("table", { name: "Branches" });
    const row = within(table).getByText("merged-feature").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete branch merged-feature" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText('Delete branch "merged-feature"?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete branch" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "delete_local_branch",
        expect.objectContaining({ repoId: 1, name: "merged-feature", force: false }),
      ),
    );
  });

  it("A7: deleting an unmerged branch shows an escalated confirmation and sends force=true", async () => {
    mockBackend(
      [baseRepo()],
      baseOverview({
        branches: [
          {
            name: "main",
            remote: null,
            merge: null,
            is_head: true,
            ahead: null,
            behind: null,
            merged: true,
            protected: false,
          },
          {
            name: "unmerged-feature",
            remote: null,
            merge: null,
            is_head: false,
            ahead: null,
            behind: null,
            merged: false,
            protected: false,
          },
        ],
      }),
    );
    renderPanel(1);

    await screen.findByText("Branches");
    const table = screen.getByRole("table", { name: "Branches" });
    const row = within(table).getByText("unmerged-feature").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete branch unmerged-feature" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText('Force delete unmerged branch "unmerged-feature"?'),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Force delete" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "delete_local_branch",
        expect.objectContaining({ name: "unmerged-feature", force: true }),
      ),
    );
  });

  it("A8: the current branch's row offers no switch/delete action", async () => {
    mockBackend([baseRepo()], baseOverview());
    renderPanel(1);

    await screen.findByText("Branches");
    const table = screen.getByRole("table", { name: "Branches" });
    const row = within(table).getByText("main").closest("tr")!;
    expect(within(row).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Switch" })).not.toBeInTheDocument();
  });

  it("MEDIUM-2: a protected, non-head branch's row offers no Delete action", async () => {
    mockBackend(
      [baseRepo()],
      baseOverview({
        branches: [
          {
            name: "main",
            remote: null,
            merge: null,
            is_head: true,
            ahead: null,
            behind: null,
            merged: true,
            protected: true,
          },
          {
            name: "release",
            remote: null,
            merge: null,
            is_head: false,
            ahead: null,
            behind: null,
            merged: true,
            // Protected via a configured override, not the current-branch
            // rule — Delete must still be withheld even though this branch
            // isn't checked out.
            protected: true,
          },
          {
            name: "feature",
            remote: null,
            merge: null,
            is_head: false,
            ahead: null,
            behind: null,
            merged: true,
            protected: false,
          },
        ],
      }),
    );
    renderPanel(1);

    await screen.findByText("Branches");
    const table = screen.getByRole("table", { name: "Branches" });
    const releaseRow = within(table).getByText("release").closest("tr")!;
    expect(
      within(releaseRow).queryByRole("button", { name: "Delete branch release" }),
    ).not.toBeInTheDocument();
    const featureRow = within(table).getByText("feature").closest("tr")!;
    expect(
      within(featureRow).getByRole("button", { name: "Delete branch feature" }),
    ).toBeInTheDocument();
  });

  it("A11: the Worktrees section lists path, branch, and status badges", async () => {
    mockBackend([baseRepo()], baseOverview(), [
      baseWorktree({ path: "/repo-a", branch: "feature-a" }),
      baseWorktree({ path: "/repo-b", branch: "feature-b", missing: true }),
      baseWorktree({ path: "/repo-c", branch: "feature-c", locked: true }),
    ]);
    renderPanel(1);

    await screen.findByText("/repo-a");
    expect(screen.getByText("feature-a")).toBeInTheDocument();
    const missingRow = screen.getByText("/repo-b").closest("tr")!;
    expect(within(missingRow).getByText("missing")).toBeInTheDocument();
    const lockedRow = screen.getByText("/repo-c").closest("tr")!;
    expect(within(lockedRow).getByText("locked")).toBeInTheDocument();
  });

  it("A13: Add worktree collects a sibling-directory default path and existing-or-new branch, and invokes add", async () => {
    mockBackend(
      [baseRepo({ path: "/Users/dev/repo", name: "repo" })],
      baseOverview({
        branches: [
          {
            name: "main",
            remote: null,
            merge: null,
            is_head: true,
            ahead: null,
            behind: null,
            merged: true,
            protected: false,
          },
          {
            name: "feature",
            remote: null,
            merge: null,
            is_head: false,
            ahead: null,
            behind: null,
            merged: true,
            protected: false,
          },
        ],
      }),
      [],
    );
    renderPanel(1);

    const pathInput = await screen.findByRole("textbox", { name: "Worktree path" });
    expect(pathInput).toHaveValue("/Users/dev/repo-main");

    const branchSelect = screen.getByRole("combobox", { name: "Worktree branch" });
    fireEvent.click(branchSelect);
    fireEvent.click(await screen.findByRole("option", { name: "feature" }));
    expect(pathInput).toHaveValue("/Users/dev/repo-feature");

    const worktreeAddCalls = () =>
      invoke.mock.calls.filter((c) => c[0] === "git_worktree_add").length;

    fireEvent.click(screen.getByRole("button", { name: "Add worktree" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "git_worktree_add",
        expect.objectContaining({
          repoId: 1,
          path: "/Users/dev/repo-feature",
          branch: "feature",
          createBranch: false,
        }),
      ),
    );
    expect(worktreeAddCalls()).toBe(1);

    // HIGH-1: clicking the "New"/"Existing" mode `Segmented` control inside
    // the form must not itself submit it (needs `type="button"`, or a native
    // form would treat it as a submit control).
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(worktreeAddCalls()).toBe(1);

    const newBranchInput = screen.getByRole("textbox", { name: "New worktree branch name" });
    fireEvent.change(newBranchInput, { target: { value: "brand-new" } });
    fireEvent.click(screen.getByRole("button", { name: "Add worktree" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "git_worktree_add",
        expect.objectContaining({ branch: "brand-new", createBranch: true }),
      ),
    );
  });

  it("A14: removing a clean worktree requires one confirmation and removes it", async () => {
    mockBackend([baseRepo()], baseOverview(), [baseWorktree({ path: "/repo-wt" })]);
    renderPanel(1);

    await screen.findByText("/repo-wt");
    const row = screen.getByText("/repo-wt").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Remove worktree /repo-wt" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Remove worktree?")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "git_worktree_remove",
        expect.objectContaining({ repoId: 1, path: "/repo-wt", force: false }),
      ),
    );
  });

  it("A15: removing a dirty worktree is refused, surfaces the reason, and the escalated path sends force=true", async () => {
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_repos") return [baseRepo()];
      if (cmd === "git_config_overview") return baseOverview();
      if (cmd === "git_worktree_list") return [baseWorktree({ path: "/repo-wt" })];
      if (cmd === "git_worktree_remove") {
        if (args?.force) return undefined;
        throw new Error("worktree has uncommitted changes");
      }
      return undefined;
    });
    renderPanel(1);

    await screen.findByText("/repo-wt");
    const row = screen.getByText("/repo-wt").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Remove worktree /repo-wt" }));

    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(useToasts.getState().toasts.some((t) => t.variant === "error")).toBe(true),
    );

    dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Force remove worktree with uncommitted changes?"),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Force remove" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "git_worktree_remove",
        expect.objectContaining({ path: "/repo-wt", force: true }),
      ),
    );
  });

  it("M3: a non-dirty worktree-remove failure shows a plain toast and never escalates", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_repos") return [baseRepo()];
      if (cmd === "git_config_overview") return baseOverview();
      if (cmd === "git_worktree_list") return [baseWorktree({ path: "/repo-wt" })];
      if (cmd === "git_worktree_remove") throw new Error("permission denied");
      return undefined;
    });
    renderPanel(1);

    await screen.findByText("/repo-wt");
    fireEvent.click(
      within(screen.getByText("/repo-wt").closest("tr")!).getByRole("button", {
        name: "Remove worktree /repo-wt",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(useToasts.getState().toasts.some((t) => t.variant === "error")).toBe(true),
    );
    // Not the dirty-worktree wording — the dialog closes instead of
    // escalating to a force option that can't possibly fix a permission error.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("M3: a locked worktree's remove failure never escalates, even if the error mentions uncommitted changes", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_repos") return [baseRepo()];
      if (cmd === "git_config_overview") return baseOverview();
      if (cmd === "git_worktree_list") return [baseWorktree({ path: "/repo-wt", locked: true })];
      if (cmd === "git_worktree_remove") throw new Error("worktree has uncommitted changes");
      return undefined;
    });
    renderPanel(1);

    await screen.findByText("/repo-wt");
    fireEvent.click(
      within(screen.getByText("/repo-wt").closest("tr")!).getByRole("button", {
        name: "Remove worktree /repo-wt",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(useToasts.getState().toasts.some((t) => t.variant === "error")).toBe(true),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("L5: Browse fills the worktree path field from a picked directory, using the same leaf name as the default", async () => {
    pickDirectoryDialog.mockResolvedValue("/Users/dev/elsewhere");
    mockBackend([baseRepo({ path: "/Users/dev/repo", name: "repo" })], baseOverview(), []);
    renderPanel(1);

    const pathInput = await screen.findByRole("textbox", { name: "Worktree path" });
    expect(pathInput).toHaveValue("/Users/dev/repo-main");

    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));

    await waitFor(() => expect(pathInput).toHaveValue("/Users/dev/elsewhere/repo-main"));
  });

  it("A16: Prune removes stale worktree entries and refreshes the list", async () => {
    mockBackend([baseRepo()], baseOverview(), [baseWorktree({ path: "/repo-wt" })]);
    renderPanel(1);

    await screen.findByText("/repo-wt");
    fireEvent.click(screen.getByRole("button", { name: "Prune" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "git_worktree_prune",
        expect.objectContaining({ repoId: 1 }),
      ),
    );
    await waitFor(() =>
      expect(invoke.mock.calls.filter((c) => c[0] === "git_worktree_list").length).toBeGreaterThan(
        1,
      ),
    );
  });

  it("A17: a worktree can be registered as a sidebar repo; an already-registered path offers no affordance", async () => {
    // #326 LOW-1: `registered` is now a backend-computed field (canonicalized
    // path match), not something the panel derives from the repos list — so
    // the mock controls it directly per worktree rather than via a matching
    // repo path.
    mockBackend([baseRepo({ path: "/repo" })], baseOverview(), [
      baseWorktree({ path: "/repo-new", registered: false }),
      baseWorktree({ path: "/repo-already", registered: true }),
    ]);
    renderPanel(1);

    await screen.findByText("/repo-new");
    const newRow = screen.getByText("/repo-new").closest("tr")!;
    const addToSidebarLabel = "Add worktree /repo-new to sidebar";
    expect(within(newRow).getByRole("button", { name: addToSidebarLabel })).toBeInTheDocument();
    fireEvent.click(within(newRow).getByRole("button", { name: addToSidebarLabel }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "register_repo",
        expect.objectContaining({ path: "/repo-new" }),
      ),
    );

    const alreadyRow = screen.getByText("/repo-already").closest("tr")!;
    expect(
      within(alreadyRow).queryByRole("button", { name: "Add to sidebar" }),
    ).not.toBeInTheDocument();
  });

  it("A18: the main worktree is never listed or actionable in the Worktrees section", async () => {
    mockBackend([baseRepo()], baseOverview(), [
      baseWorktree({ path: "/main-checkout", is_main: true }),
      baseWorktree({ path: "/repo-linked" }),
    ]);
    renderPanel(1);

    await screen.findByText("/repo-linked");
    expect(screen.queryByText("/main-checkout")).not.toBeInTheDocument();
  });

  it("A19: a failed rename surfaces a toast with the backend error and leaves the panel functional", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_repos") return [baseRepo()];
      if (cmd === "git_config_overview")
        return baseOverview({
          branches: [
            {
              name: "main",
              remote: null,
              merge: null,
              is_head: true,
              ahead: null,
              behind: null,
              merged: true,
              protected: false,
            },
            {
              name: "old-name",
              remote: null,
              merge: null,
              is_head: false,
              ahead: null,
              behind: null,
              merged: true,
              protected: false,
            },
          ],
        });
      if (cmd === "git_worktree_list") return [];
      if (cmd === "rename_branch") throw new Error("branch already exists");
      return undefined;
    });
    renderPanel(1);

    await screen.findByText("Branches");
    const table = screen.getByRole("table", { name: "Branches" });
    const row = within(table).getByText("old-name").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Rename branch old-name" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rename old-name" }), {
      target: { value: "clash" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(useToasts.getState().toasts.some((t) => t.variant === "error")).toBe(true),
    );
    expect(await screen.findByRole("button", { name: "Refresh" })).not.toBeDisabled();
  });

  it("A23 (#326): destructive flows render the app's Dialog, never window.confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockImplementation(() => {
      throw new Error("window.confirm must never be called");
    });
    mockBackend(
      [baseRepo()],
      baseOverview({
        branches: [
          {
            name: "main",
            remote: null,
            merge: null,
            is_head: true,
            ahead: null,
            behind: null,
            merged: true,
            protected: false,
          },
          {
            name: "feature",
            remote: null,
            merge: null,
            is_head: false,
            ahead: null,
            behind: null,
            merged: true,
            protected: false,
          },
        ],
      }),
      [baseWorktree({ path: "/repo-wt" })],
    );
    renderPanel(1);

    await screen.findByText("Branches");
    const branchesTable = screen.getByRole("table", { name: "Branches" });
    fireEvent.click(
      within(within(branchesTable).getByText("feature").closest("tr")!).getByRole("button", {
        name: "Delete branch feature",
      }),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await screen.findByText("/repo-wt");
    fireEvent.click(
      within(screen.getByText("/repo-wt").closest("tr")!).getByRole("button", {
        name: "Remove worktree /repo-wt",
      }),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("A24: a successful worktree remove invalidates the repos and linked-worktrees query keys", async () => {
    mockBackend([baseRepo()], baseOverview(), [baseWorktree({ path: "/repo-wt" })]);
    const { qc } = renderPanelWithClient(1);
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    await screen.findByText("/repo-wt");
    fireEvent.click(
      within(screen.getByText("/repo-wt").closest("tr")!).getByRole("button", {
        name: "Remove worktree /repo-wt",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["repos"] })),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["linked-worktrees", 1] }),
    );
    // M4: worktree/branch mutations go through one shared invalidation helper
    // (mirroring `BranchSwitcher`/`CleanupStaleDialog`) — spot-check one more
    // of its keys rather than re-asserting every one here.
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["branches", 1] }),
    );
  });
});
