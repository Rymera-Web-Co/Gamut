import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

import type { SyncStatus } from "@/lib/ipc";

// The hook pulls in the whole app shell; stub everything but the ui store, whose
// real `pushConfirm` is what the push gate is asserted against.
const pushMutate = vi.hoisted(() => vi.fn());
const pullMutate = vi.hoisted(() => vi.fn());
const busy = vi.hoisted(() => ({ value: false }));
const syncStatus = vi.hoisted(() => ({
  value: { upstream: "origin/main", ahead: 0, behind: 0, unpublished_branch: null } as SyncStatus,
}));
const gitSyncStatus = vi.hoisted(() =>
  vi.fn((_repoId: number) => Promise.resolve({} as SyncStatus)),
);

vi.mock("@/features/repos/api", () => ({
  useRepos: () => ({ data: [] }),
  useGroups: () => ({ data: [] }),
  useFetchGroup: () => ({ mutate: vi.fn() }),
}));
// Records the repo each mutation was built for, so a push aimed at the wrong
// repo is visible to the assertions rather than collapsing into one spy, and
// every repo the hook was handed across renders (the real `useSyncActions`
// rebuilds its mutation from the latest render, so a render with `null` is what
// makes a push fail with "No active repository").
const syncActionsFor = vi.hoisted(() => ({ value: [] as (number | null)[] }));
vi.mock("@/features/sync/useSyncActions", () => ({
  useSyncActions: (repoId: number | null) => {
    syncActionsFor.value.push(repoId);
    return {
      push: { mutate: () => pushMutate(repoId) },
      pull: { mutate: () => pullMutate(repoId) },
      busy: busy.value,
    };
  },
}));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    touchRepo: vi.fn(),
    terminalRegistryReport: vi.fn(),
    gitSyncStatus: (repoId: number) => gitSyncStatus(repoId),
  },
}));
vi.mock("@/lib/settings", () => {
  const state = { values: { keybindings: "", terminalRestoreSessions: false } };
  const useSettings = Object.assign((sel: (s: typeof state) => unknown) => sel(state), {
    getState: () => state,
  });
  return { useSettings };
});
vi.mock("@/lib/theme", () => ({
  useTheme: (sel: (s: unknown) => unknown) => sel({ toggle: vi.fn() }),
}));

import { PublishBranchDialog } from "@/features/sync/PublishBranchDialog";
import { isMac } from "@/lib/shortcuts";
import { useUiStore } from "@/store/ui";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

/** The shortcut listener plus the dialog it raises — the whole ⌘⇧K path. */
function Harness() {
  useKeyboardShortcuts();
  return <PublishBranchDialog />;
}

/** Press the default push binding (⌘⇧K on macOS, Ctrl+Shift+K elsewhere). */
function pressPushShortcut() {
  const mac = isMac();
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      code: "KeyK",
      shiftKey: true,
      metaKey: mac,
      ctrlKey: !mac,
      bubbles: true,
    }),
  );
}

const confirmation = () => screen.queryByRole("dialog");

describe("⌘⇧K first-publish gate (#300)", () => {
  beforeEach(() => {
    pushMutate.mockClear();
    gitSyncStatus.mockClear();
    syncActionsFor.value = [];
    busy.value = false;
    syncStatus.value = { upstream: "origin/main", ahead: 0, behind: 0, unpublished_branch: null };
    gitSyncStatus.mockImplementation(() => Promise.resolve(syncStatus.value));
    useUiStore.setState({ activeRepoId: 1, pushConfirm: null });
  });

  it("pushes a tracking branch straight through", async () => {
    render(<Harness />);

    pressPushShortcut();

    await waitFor(() => expect(pushMutate).toHaveBeenCalledTimes(1));
    expect(pushMutate).toHaveBeenCalledWith(1);
    expect(useUiStore.getState().pushConfirm).toBeNull();
    expect(confirmation()).toBeNull();
  });

  it("asks before publishing a branch with no upstream", async () => {
    syncStatus.value = {
      upstream: null,
      ahead: 0,
      behind: 0,
      unpublished_branch: "feat/300-thing",
    };
    render(<Harness />);

    pressPushShortcut();

    // The question is asked app-level, so it shows even with no sidebar row.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("feat/300-thing");
    expect(dialog).toHaveTextContent("origin");
    expect(pushMutate).not.toHaveBeenCalled();
    expect(useUiStore.getState().pushConfirm).toEqual({ repoId: 1, branch: "feat/300-thing" });
  });

  it("publishes on confirm and does nothing on cancel", async () => {
    syncStatus.value = {
      upstream: null,
      ahead: 0,
      behind: 0,
      unpublished_branch: "feat/300-thing",
    };
    render(<Harness />);

    pressPushShortcut();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(confirmation()).toBeNull());
    expect(pushMutate).not.toHaveBeenCalled();

    pressPushShortcut();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Publish branch" }));
    await waitFor(() => expect(pushMutate).toHaveBeenCalledTimes(1));
    // The push targets the repo the question was asked about.
    expect(pushMutate).toHaveBeenCalledWith(1);
    expect(confirmation()).toBeNull();
  });

  it("keeps the push pointed at the repo while the dialog closes", async () => {
    // Answering both clears the question and fires the push. The mutation reads
    // whatever repo the latest render supplied, so if clearing hands the hook a
    // `null` the push dies with "No active repository" — no branch published,
    // just an error toast. Observed in the running app; pinned here.
    syncStatus.value = {
      upstream: null,
      ahead: 0,
      behind: 0,
      unpublished_branch: "feat/300-thing",
    };
    render(<Harness />);
    pressPushShortcut();
    await screen.findByRole("dialog");
    const sinceAsked = syncActionsFor.value.length;

    fireEvent.click(screen.getByRole("button", { name: "Publish branch" }));

    await waitFor(() => expect(useUiStore.getState().pushConfirm).toBeNull());
    // From the question being posed through the push, the hook is only ever
    // handed the repo it was asked about — never `null`.
    expect(syncActionsFor.value.slice(sinceAsked)).not.toContain(null);
    expect(syncActionsFor.value[syncActionsFor.value.length - 1]).toBe(1);
  });

  it("resolves the gate against the repo that was active when the key was pressed", async () => {
    render(<Harness />);
    act(() => useUiStore.setState({ activeRepoId: 7 }));

    pressPushShortcut();

    await waitFor(() => expect(gitSyncStatus).toHaveBeenCalledWith(7));
    expect(gitSyncStatus).toHaveBeenCalledTimes(1);
  });

  it("drops the push if the selection moves while the check is in flight", async () => {
    // The push mutation follows whatever repo is active now, so pushing after
    // the user switched would hit a repo they never asked about — and skip its
    // own confirmation, since the answer in hand is about the old one.
    let resolveCheck: (s: SyncStatus) => void = () => {};
    gitSyncStatus.mockImplementationOnce(() => new Promise<SyncStatus>((r) => (resolveCheck = r)));
    render(<Harness />);

    pressPushShortcut();
    await waitFor(() => expect(gitSyncStatus).toHaveBeenCalledWith(1));
    act(() => useUiStore.setState({ activeRepoId: 2 }));
    resolveCheck({ upstream: "origin/main", ahead: 0, behind: 0, unpublished_branch: null });

    await waitFor(() => expect(gitSyncStatus).toHaveBeenCalledTimes(1));
    expect(pushMutate).not.toHaveBeenCalled();
    expect(useUiStore.getState().pushConfirm).toBeNull();
  });

  it("does not start a second check while one is in flight", async () => {
    // Key auto-repeat fires keydown every few milliseconds; `busy` only covers a
    // push that has already started, so without its own guard the gate would run
    // repeatedly and land duplicate pushes.
    let resolveCheck: (s: SyncStatus) => void = () => {};
    gitSyncStatus.mockImplementationOnce(() => new Promise<SyncStatus>((r) => (resolveCheck = r)));
    render(<Harness />);

    pressPushShortcut();
    pressPushShortcut();
    pressPushShortcut();

    expect(gitSyncStatus).toHaveBeenCalledTimes(1);
    resolveCheck({ upstream: "origin/main", ahead: 0, behind: 0, unpublished_branch: null });
    await waitFor(() => expect(pushMutate).toHaveBeenCalledTimes(1));
  });

  it("does nothing while a sync is already in flight", async () => {
    syncStatus.value = {
      upstream: null,
      ahead: 0,
      behind: 0,
      unpublished_branch: "feat/300-thing",
    };
    busy.value = true;
    render(<Harness />);

    pressPushShortcut();

    await waitFor(() => expect(gitSyncStatus).not.toHaveBeenCalled());
    expect(pushMutate).not.toHaveBeenCalled();
    expect(useUiStore.getState().pushConfirm).toBeNull();
  });

  it("does nothing when there is no active repo", async () => {
    useUiStore.setState({ activeRepoId: null });
    render(<Harness />);

    pressPushShortcut();

    await waitFor(() => expect(gitSyncStatus).not.toHaveBeenCalled());
    expect(pushMutate).not.toHaveBeenCalled();
  });
});
