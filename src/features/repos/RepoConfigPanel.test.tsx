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

import type { ConfigOverview, Repo } from "@/lib/ipc";
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
    branches: [{ name: "main", remote: "origin", merge: "refs/heads/main", is_head: true }],
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

/** Route `invoke` calls to fixed repos/overview fixtures, ignoring writes
 * (each returns `undefined`, i.e. success) unless the test overrides it. */
function mockBackend(repos: Repo[], overview: ConfigOverview) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "list_repos") return repos;
    if (cmd === "git_config_overview") return overview;
    return undefined;
  });
}

beforeEach(() => {
  invoke.mockReset();
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

  it("A9: the editable-control set is exactly identity, one URL field per remote, and the branch/upstream pickers", async () => {
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
      new Set(["user.name", "user.email", "origin URL", "upstream URL", "Branch", "Upstream"]),
    );
    expect(names).toHaveLength(6);
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
          { name: "main", remote: "origin", merge: "refs/heads/main", is_head: true },
          { name: "second", remote: null, merge: null, is_head: false },
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
});
