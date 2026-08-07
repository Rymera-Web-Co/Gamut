import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { SyncStatus } from "@/lib/ipc";

// The sync calls go through the ipc bridge; stub it so the component runs
// without a Tauri backend and the tests can assert what a push actually did.
// `gitSyncStatus` is the pre-push check that decides whether to confirm.
const gitPush = vi.hoisted(() => vi.fn((_repoId: number) => Promise.resolve("Pushed")));
const gitPull = vi.hoisted(() =>
  vi.fn((_repoId: number) => Promise.resolve("Already up to date.")),
);
const syncStatus = vi.hoisted(() => ({
  value: { upstream: "origin/main", ahead: 0, behind: 0, unpublished_branch: null } as SyncStatus,
}));
const gitSyncStatus = vi.hoisted(() =>
  vi.fn((_repoId: number) => Promise.resolve({} as SyncStatus)),
);
vi.mock("@/lib/ipc", () => ({
  ipc: {
    gitPush: (repoId: number) => gitPush(repoId),
    gitPull: (repoId: number) => gitPull(repoId),
    gitSyncStatus: (repoId: number) => gitSyncStatus(repoId),
    repoStatus: () => Promise.resolve({}),
  },
}));
vi.mock("@/store/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { SyncControls } from "./SyncControls";

function renderControls(props: Partial<React.ComponentProps<typeof SyncControls>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SyncControls repoId={1} {...props} />
    </QueryClientProvider>,
  );
}

const confirmation = () => screen.queryByRole("dialog", { name: "Publish branch to origin" });
const pushButton = () => screen.getByTitle("Push (⌘⇧K)");

/** Click push and wait for the pre-push check to resolve either way. */
async function clickPush() {
  fireEvent.click(pushButton());
  await waitFor(() => expect(gitSyncStatus).toHaveBeenCalled());
}

describe("SyncControls first-publish confirmation (#300)", () => {
  beforeEach(() => {
    gitPush.mockClear();
    gitPull.mockClear();
    gitSyncStatus.mockClear();
    syncStatus.value = { upstream: "origin/main", ahead: 0, behind: 0, unpublished_branch: null };
    gitSyncStatus.mockImplementation(() => Promise.resolve(syncStatus.value));
  });

  it("pushes immediately when the branch tracks an upstream", async () => {
    renderControls({ ahead: 2 });

    await clickPush();

    await waitFor(() => expect(gitPush).toHaveBeenCalledTimes(1));
    expect(confirmation()).toBeNull();
  });

  it("asks before publishing a branch with no upstream", async () => {
    syncStatus.value = {
      upstream: null,
      ahead: 0,
      behind: 0,
      unpublished_branch: "feat/300-thing",
    };
    renderControls();

    await clickPush();

    // The confirmation names the branch and the remote it would land on.
    const popover = await screen.findByRole("dialog", { name: "Publish branch to origin" });
    expect(popover).toHaveTextContent("feat/300-thing");
    expect(popover).toHaveTextContent("origin");
    // Nothing was published while the question is still open.
    expect(gitPush).not.toHaveBeenCalled();
  });

  it("confirming publishes the branch", async () => {
    syncStatus.value = {
      upstream: null,
      ahead: 0,
      behind: 0,
      unpublished_branch: "feat/300-thing",
    };
    renderControls();
    await clickPush();
    await screen.findByRole("dialog", { name: "Publish branch to origin" });

    fireEvent.click(screen.getByRole("button", { name: "Publish branch" }));

    await waitFor(() => expect(gitPush).toHaveBeenCalledTimes(1));
    expect(gitPush).toHaveBeenCalledWith(1);
    await waitFor(() => expect(confirmation()).toBeNull());
  });

  it("cancelling does not push", async () => {
    syncStatus.value = {
      upstream: null,
      ahead: 0,
      behind: 0,
      unpublished_branch: "feat/300-thing",
    };
    renderControls();
    await clickPush();
    await screen.findByRole("dialog", { name: "Publish branch to origin" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(confirmation()).toBeNull());
    expect(gitPush).not.toHaveBeenCalled();
  });

  it("dismisses on Escape without pushing", async () => {
    syncStatus.value = {
      upstream: null,
      ahead: 0,
      behind: 0,
      unpublished_branch: "feat/300-thing",
    };
    renderControls();
    await clickPush();
    await screen.findByRole("dialog", { name: "Publish branch to origin" });

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    await waitFor(() => expect(confirmation()).toBeNull());
    expect(gitPush).not.toHaveBeenCalled();
  });

  it("takes the confirmation with it when the row unmounts", async () => {
    syncStatus.value = {
      upstream: null,
      ahead: 0,
      behind: 0,
      unpublished_branch: "feat/300-thing",
    };
    const { unmount } = renderControls();
    await clickPush();
    await screen.findByRole("dialog", { name: "Publish branch to origin" });

    // Hiding the sidebar unmounts the row. Remounting must not re-raise the
    // question the user never answered.
    unmount();
    renderControls();

    expect(confirmation()).toBeNull();
    expect(gitPush).not.toHaveBeenCalled();
  });

  it("does not block the push when the pre-push check fails", async () => {
    // An unreadable repo shouldn't make the button dead; git reports the error.
    gitSyncStatus.mockImplementation(() => Promise.reject(new Error("not a repository")));
    renderControls();

    await clickPush();

    await waitFor(() => expect(gitPush).toHaveBeenCalledTimes(1));
    expect(confirmation()).toBeNull();
  });

  it("holds the button while the check is in flight, then pushes once", async () => {
    let resolveCheck: (s: SyncStatus) => void = () => {};
    gitSyncStatus.mockImplementationOnce(() => new Promise<SyncStatus>((r) => (resolveCheck = r)));
    renderControls();

    fireEvent.click(pushButton());
    await waitFor(() => expect(pushButton()).toBeDisabled());
    expect(gitPush).not.toHaveBeenCalled();

    resolveCheck(syncStatus.value);
    await waitFor(() => expect(gitPush).toHaveBeenCalledTimes(1));
    expect(gitSyncStatus).toHaveBeenCalledTimes(1);
  });

  it("closes the confirmation when the push button is clicked again", async () => {
    syncStatus.value = {
      upstream: null,
      ahead: 0,
      behind: 0,
      unpublished_branch: "feat/300-thing",
    };
    renderControls();
    await clickPush();
    await screen.findByRole("dialog", { name: "Publish branch to origin" });

    // A second click toggles it shut rather than re-asking the backend.
    fireEvent.click(pushButton());

    await waitFor(() => expect(confirmation()).toBeNull());
    expect(gitSyncStatus).toHaveBeenCalledTimes(1);
    expect(gitPush).not.toHaveBeenCalled();
  });

  it("stays disabled while a sync is in flight", async () => {
    let resolvePull: (v: string) => void = () => {};
    gitPull.mockImplementationOnce(() => new Promise<string>((r) => (resolvePull = r)));
    renderControls();

    fireEvent.click(screen.getByTitle("Pull (⌘⇧P)"));
    await waitFor(() => expect(pushButton()).toBeDisabled());
    expect(gitSyncStatus).not.toHaveBeenCalled();

    resolvePull("done");
  });

  it("still renders the ahead/behind counts", () => {
    renderControls({ ahead: 3, behind: 5 });

    expect(pushButton()).toHaveTextContent("3");
    expect(screen.getByTitle("Pull (⌘⇧P)")).toHaveTextContent("5");
  });
});
