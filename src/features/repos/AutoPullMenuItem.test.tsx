import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Repo } from "@/lib/ipc";

const setRepoAutoPull = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/ipc", () => ({ ipc: { setRepoAutoPull } }));

const error = vi.fn();
vi.mock("@/store/toast", () => ({ toast: { error: (m: string) => error(m) } }));

import { canAutoPull } from "@/lib/autoPull";

import { AutoPullMenuItem } from "./AutoPullMenuItem";

function repo(over: Partial<Repo> = {}): Repo {
  return {
    id: 42,
    path: "/repos/shared-lib",
    name: "shared-lib",
    default_branch: "main",
    last_opened: null,
    created_at: "2026-01-01",
    tag_ids: [],
    group_ids: [],
    missing: false,
    is_git_repo: true,
    has_worktrees: false,
    auto_pull: false,
    ...over,
  };
}

/** Render the item with a real query client so the invalidation is observable. */
function renderItem(r: Repo) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateQueries = vi.spyOn(qc, "invalidateQueries");
  const onDone = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <AutoPullMenuItem repo={r} onDone={onDone} />
    </QueryClientProvider>,
  );
  return { item: screen.getByRole("menuitem"), invalidateQueries, onDone };
}

describe("AutoPullMenuItem (issue #299)", () => {
  beforeEach(() => {
    setRepoAutoPull.mockReset();
    setRepoAutoPull.mockResolvedValue(undefined);
    error.mockClear();
  });

  it("A19: shows the repo's current state — off", () => {
    const { item } = renderItem(repo({ auto_pull: false }));

    expect(item).toHaveTextContent("Auto-pull: off");
  });

  it("A19: shows the repo's current state — on", () => {
    const { item } = renderItem(repo({ auto_pull: true }));

    expect(item).toHaveTextContent("Auto-pull: on");
  });

  it("the state icon is decorative — it isn't announced on top of the label", () => {
    const { item } = renderItem(repo({ auto_pull: true }));

    const icon = item.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).not.toHaveAttribute("aria-label");
  });

  it("A19: activating it turns auto-pull ON for that repo", async () => {
    const { item, onDone } = renderItem(repo({ id: 7, auto_pull: false }));

    fireEvent.click(item);

    // `mutate` dispatches the ipc call in a microtask, so wait for it.
    await waitFor(() => expect(setRepoAutoPull).toHaveBeenCalledTimes(1));
    expect(setRepoAutoPull).toHaveBeenCalledWith(7, true);
    // The menu closes on activation rather than staying open on a stale state.
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("A19: activating it again turns auto-pull OFF (the value is flipped, not forced)", async () => {
    const { item } = renderItem(repo({ id: 7, auto_pull: true }));

    fireEvent.click(item);

    await waitFor(() => expect(setRepoAutoPull).toHaveBeenCalledWith(7, false));
  });

  it("A19: invalidates the repos query so the new flag is re-read", async () => {
    const { item, invalidateQueries } = renderItem(repo());

    fireEvent.click(item);

    // The mutation's onSuccess is what re-reads the flag.
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["repos"] }));
  });

  it("a failed write is surfaced instead of silently not taking", async () => {
    setRepoAutoPull.mockRejectedValue(new Error("database is locked"));
    const { item } = renderItem(repo());

    fireEvent.click(item);

    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error.mock.calls[0][0]).toContain("database is locked");
  });

  // The sidebar gates the item on this predicate (`canAutoPull(menu.repo) && …`),
  // so this covers the rule; it does not exercise that one line of sidebar JSX.
  it("A19: the opt-in is offered for a normal git repo and withheld otherwise", () => {
    expect(canAutoPull(repo())).toBe(true);
    expect(canAutoPull(repo({ is_git_repo: false }))).toBe(false);
    expect(canAutoPull(repo({ missing: true }))).toBe(false);
  });
});
