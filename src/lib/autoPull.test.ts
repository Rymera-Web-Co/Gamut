import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AutoPullResult, AutoPullStatus, Repo } from "@/lib/ipc";

const listRepos = vi.fn();
const gitPullFfMany = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: {
    listRepos: (...args: unknown[]) => listRepos(...args),
    gitPullFfMany: (...args: unknown[]) => gitPullFfMany(...args),
  },
}));

const success = vi.fn();
const info = vi.fn();
const error = vi.fn();
vi.mock("@/store/toast", () => ({
  toast: {
    success: (m: string) => success(m),
    info: (m: string) => info(m),
    error: (m: string) => error(m),
  },
}));

// The engine must never refresh the query cache itself — the caller owns that, so
// a fetch-cycle pull folds into the fetch's single refresh round. `autoPull.ts`
// deliberately doesn't import this module at all; the spy is a tripwire for a
// future import sneaking in, not evidence on its own.
const patchRepoStatuses = vi.fn();
const refreshScopedRepos = vi.fn();
vi.mock("@/lib/repoStatusRefresh", () => ({
  patchRepoStatuses: (...args: unknown[]) => patchRepoStatuses(...args),
  refreshScopedRepos: (...args: unknown[]) => refreshScopedRepos(...args),
}));

import { resetAutoPullState, runAutoPull } from "@/lib/autoPull";

function repo(id: number, over: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/repos/r${id}`,
    name: `repo-${id}`,
    default_branch: "main",
    last_opened: null,
    created_at: "2026-01-01",
    tag_ids: [],
    group_ids: [],
    missing: false,
    is_git_repo: true,
    has_worktrees: false,
    auto_pull: true,
    ...over,
  };
}

function result(repo_id: number, status: AutoPullStatus, over: Partial<AutoPullResult> = {}) {
  return { repo_id, status, output: null, error: null, ...over } as AutoPullResult;
}

/** Real `git pull` stdout — the shape the backend hands back for a pulled repo. */
const PULL_OUTPUT = [
  "Updating 1a2b3c4..5d6e7f8",
  "Fast-forward",
  " src/a.ts | 4 ++--",
  " 1 file changed, 2 insertions(+), 2 deletions(-)",
].join("\n");

describe("runAutoPull — candidate selection (#299)", () => {
  beforeEach(() => {
    resetAutoPullState();
    vi.clearAllMocks();
    gitPullFfMany.mockResolvedValue([]);
  });

  it("A9: only asks about repos that are opted in, present, and git repos", async () => {
    listRepos.mockResolvedValue([
      repo(1),
      repo(2, { auto_pull: false }),
      repo(3, { missing: true }),
      repo(4, { is_git_repo: false }),
      repo(5),
    ]);

    await runAutoPull();

    expect(gitPullFfMany).toHaveBeenCalledTimes(1);
    expect(gitPullFfMany).toHaveBeenCalledWith([1, 5]);
  });

  it("A20: with nothing opted in, the backend is never called", async () => {
    listRepos.mockResolvedValue([repo(1, { auto_pull: false }), repo(2, { auto_pull: false })]);

    await expect(runAutoPull()).resolves.toEqual([]);

    expect(gitPullFfMany).not.toHaveBeenCalled();
  });

  it("A10: intersects with the caller's candidate ids (the fetch's succeeded set)", async () => {
    listRepos.mockResolvedValue([repo(1), repo(2), repo(3)]);

    await runAutoPull([2, 3, 99]);

    expect(gitPullFfMany).toHaveBeenCalledWith([2, 3]);
  });

  it("stays quiet when the backend call fails", async () => {
    listRepos.mockResolvedValue([repo(1)]);
    gitPullFfMany.mockRejectedValue(new Error("ipc down"));

    await expect(runAutoPull()).resolves.toEqual([]);

    expect(error).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});

describe("runAutoPull — reporting (#299)", () => {
  beforeEach(() => {
    resetAutoPullState();
    vi.clearAllMocks();
    listRepos.mockResolvedValue([repo(1), repo(2)]);
  });

  it("A11: condenses git's output into one line via summarizePull", async () => {
    gitPullFfMany.mockResolvedValue([result(1, "pulled", { output: PULL_OUTPUT })]);

    await runAutoPull();

    expect(success).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledWith(
      "repo-1: Pulled · 1 file changed, 2 insertions(+), 2 deletions(-)",
    );
    // The raw multi-line report never reaches a toast.
    expect(success.mock.calls[0][0]).not.toContain("\n");
  });

  it("A13: returns the pulled ids and refreshes nothing itself", async () => {
    gitPullFfMany.mockResolvedValue([
      result(1, "pulled", { output: PULL_OUTPUT }),
      result(2, "skipped-dirty"),
    ]);

    await expect(runAutoPull()).resolves.toEqual([1]);

    expect(patchRepoStatuses).not.toHaveBeenCalled();
    expect(refreshScopedRepos).not.toHaveBeenCalled();
  });

  it("an up-to-date repo produces no toast at all", async () => {
    gitPullFfMany.mockResolvedValue([result(1, "up-to-date")]);

    await expect(runAutoPull()).resolves.toEqual([]);

    expect(success).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("warns non-blockingly (never an error toast) with the reason, per skip kind", async () => {
    const cases: [AutoPullStatus, string][] = [
      ["skipped-dirty", "uncommitted changes"],
      ["skipped-diverged", "diverged"],
      ["skipped-no-upstream", "no upstream"],
    ];
    for (const [status, fragment] of cases) {
      resetAutoPullState();
      info.mockClear();
      gitPullFfMany.mockResolvedValue([result(1, status)]);

      await runAutoPull();

      expect(info, status).toHaveBeenCalledTimes(1);
      expect(info.mock.calls[0][0]).toContain(fragment);
      expect(error).not.toHaveBeenCalled();
    }
  });

  it("surfaces a failed pull as a non-blocking warning carrying git's error", async () => {
    gitPullFfMany.mockResolvedValue([result(1, "failed", { error: "Could not resolve host" })]);

    await runAutoPull();

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toContain("Could not resolve host");
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps a multi-line git error to one line in the toast", async () => {
    const gitError = [
      "error: Your local changes to the following files would be overwritten:",
      "\tsrc/a.ts",
      "Please commit your changes or stash them before you merge.",
      "Aborting",
    ].join("\n");
    gitPullFfMany.mockResolvedValue([result(1, "failed", { error: gitError })]);

    await runAutoPull();

    expect(info).toHaveBeenCalledTimes(1);
    const message = info.mock.calls[0][0] as string;
    expect(message).not.toContain("\n");
    expect(message).toContain("would be overwritten");
  });

  it("says nothing at all about a repo that wasn't available to pull", async () => {
    gitPullFfMany.mockResolvedValue([result(1, "skipped-unavailable")]);

    await expect(runAutoPull()).resolves.toEqual([]);

    expect(info).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });
});

describe("runAutoPull — warning de-duplication (#299)", () => {
  beforeEach(() => {
    resetAutoPullState();
    vi.clearAllMocks();
    listRepos.mockResolvedValue([repo(1), repo(2)]);
  });

  it("A12: the same reason on a later round is silent", async () => {
    gitPullFfMany.mockResolvedValue([result(1, "skipped-dirty")]);

    await runAutoPull();
    await runAutoPull();
    await runAutoPull();

    expect(info).toHaveBeenCalledTimes(1);
  });

  it("A12: a changed reason warns again", async () => {
    gitPullFfMany.mockResolvedValueOnce([result(1, "skipped-dirty")]);
    await runAutoPull();
    gitPullFfMany.mockResolvedValueOnce([result(1, "skipped-diverged")]);
    await runAutoPull();

    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[1][0]).toContain("diverged");
  });

  it("A12: an intervening success resets the memory, so a recurrence warns again", async () => {
    gitPullFfMany.mockResolvedValueOnce([result(1, "skipped-dirty")]);
    await runAutoPull();
    gitPullFfMany.mockResolvedValueOnce([result(1, "pulled", { output: PULL_OUTPUT })]);
    await runAutoPull();
    gitPullFfMany.mockResolvedValueOnce([result(1, "skipped-dirty")]);
    await runAutoPull();

    expect(info).toHaveBeenCalledTimes(2);
  });

  it("A12: an intervening up-to-date round also resets the memory", async () => {
    gitPullFfMany.mockResolvedValueOnce([result(1, "skipped-dirty")]);
    await runAutoPull();
    gitPullFfMany.mockResolvedValueOnce([result(1, "up-to-date")]);
    await runAutoPull();
    gitPullFfMany.mockResolvedValueOnce([result(1, "skipped-dirty")]);
    await runAutoPull();

    expect(info).toHaveBeenCalledTimes(2);
  });

  it("A12: two *different* failure messages both get through", async () => {
    gitPullFfMany.mockResolvedValueOnce([result(1, "failed", { error: "Could not resolve host" })]);
    await runAutoPull();
    gitPullFfMany.mockResolvedValueOnce([result(1, "failed", { error: "Permission denied" })]);
    await runAutoPull();
    // …but a repeat of the same message stays quiet.
    gitPullFfMany.mockResolvedValueOnce([result(1, "failed", { error: "Permission denied" })]);
    await runAutoPull();

    expect(info).toHaveBeenCalledTimes(2);
  });

  it("A12: an intervening 'unavailable' round also resets the memory", async () => {
    gitPullFfMany.mockResolvedValueOnce([result(1, "skipped-dirty")]);
    await runAutoPull();
    gitPullFfMany.mockResolvedValueOnce([result(1, "skipped-unavailable")]);
    await runAutoPull();
    gitPullFfMany.mockResolvedValueOnce([result(1, "skipped-dirty")]);
    await runAutoPull();

    expect(info).toHaveBeenCalledTimes(2);
  });

  it("A12: the memory is per repo — a second repo skipping for the same reason still warns", async () => {
    gitPullFfMany.mockResolvedValue([result(1, "skipped-dirty"), result(2, "skipped-dirty")]);

    await runAutoPull();

    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[0][0]).toContain("repo-1");
    expect(info.mock.calls[1][0]).toContain("repo-2");
  });
});

describe("runAutoPull — overlapping rounds (#299)", () => {
  beforeEach(() => {
    resetAutoPullState();
    vi.clearAllMocks();
    listRepos.mockResolvedValue([repo(1)]);
  });

  it("A22: a second trigger while a round is in flight joins it instead of pulling twice", async () => {
    let release: (value: AutoPullResult[]) => void = () => {};
    gitPullFfMany.mockReturnValue(
      new Promise<AutoPullResult[]>((resolve) => {
        release = resolve;
      }),
    );

    const first = runAutoPull();
    // Let the first round get as far as its in-flight backend call.
    await Promise.resolve();
    await Promise.resolve();
    const second = runAutoPull();

    release([result(1, "pulled", { output: PULL_OUTPUT })]);
    const [a, b] = await Promise.all([first, second]);

    expect(gitPullFfMany).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledTimes(1);
    expect(a).toEqual([1]);
    expect(b).toEqual([1]);
  });

  it("A22: once a round settles, the next trigger runs normally", async () => {
    gitPullFfMany.mockResolvedValue([result(1, "up-to-date")]);

    await runAutoPull();
    await runAutoPull();

    expect(gitPullFfMany).toHaveBeenCalledTimes(2);
  });

  it("A22: a *wider* request queues behind a narrow round instead of joining it", async () => {
    // A fetch-cycle round covering only repo 1 is in flight when a focus regain
    // asks for every opted-in repo. Joining would silently drop repo 2.
    listRepos.mockResolvedValue([repo(1), repo(2)]);
    let release: (value: AutoPullResult[]) => void = () => {};
    gitPullFfMany.mockReturnValueOnce(
      new Promise<AutoPullResult[]>((resolve) => {
        release = resolve;
      }),
    );
    gitPullFfMany.mockResolvedValue([result(1, "up-to-date"), result(2, "up-to-date")]);

    const narrow = runAutoPull([1]);
    await Promise.resolve();
    await Promise.resolve();
    const wide = runAutoPull();

    // The wide round must not have started while the narrow one is in flight.
    expect(gitPullFfMany).toHaveBeenCalledTimes(1);

    release([result(1, "up-to-date")]);
    await Promise.all([narrow, wide]);

    expect(gitPullFfMany).toHaveBeenCalledTimes(2);
    expect(gitPullFfMany).toHaveBeenLastCalledWith([1, 2]);
  });
});

describe("runAutoPull — preloaded repo list (#299)", () => {
  beforeEach(() => {
    resetAutoPullState();
    vi.clearAllMocks();
    gitPullFfMany.mockResolvedValue([]);
  });

  it("uses a caller-supplied repo list instead of re-listing repos", async () => {
    await runAutoPull([1], [repo(1), repo(2)]);

    expect(listRepos).not.toHaveBeenCalled();
    expect(gitPullFfMany).toHaveBeenCalledWith([1]);
  });
});
