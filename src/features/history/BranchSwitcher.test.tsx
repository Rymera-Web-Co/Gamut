import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { BranchInfo } from "@/lib/ipc";

// Branch/tag lists are fetched through the ipc bridge; feed fixed data so the
// dropdown renders synchronously without a Tauri backend.
const branches = vi.hoisted(() => ({ value: [] as BranchInfo[] }));
const tags = vi.hoisted(() => ({ value: [] as string[] }));
const createBranch = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    listBranches: () => Promise.resolve(branches.value),
    listGitTags: () => Promise.resolve(tags.value),
    checkoutBranch: () => Promise.resolve(),
    createBranch,
  },
}));
vi.mock("@/lib/settings", () => ({
  useSettings: (sel: (s: { values: { baseBranchPrecedence: string } }) => unknown) =>
    sel({ values: { baseBranchPrecedence: "main,master" } }),
}));
vi.mock("@/features/repos/api", () => ({ useRepos: () => ({ data: [] }) }));
// The cleanup dialog is closed in these tests and pulls in unrelated deps.
vi.mock("./CleanupStaleDialog", () => ({ CleanupStaleDialog: () => null }));

import { BranchSwitcher } from "./BranchSwitcher";

function renderSwitcher(props: { repoId: number; currentBranch?: string | null }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BranchSwitcher {...props} />
    </QueryClientProvider>,
  );
}

describe("BranchSwitcher truncation tooltips (#251)", () => {
  beforeEach(() => {
    branches.value = [];
    tags.value = [];
  });

  it("exposes the full current branch name as a title on the truncated trigger label", () => {
    const long = "origin/feature/admin-settings-redesign";
    renderSwitcher({ repoId: 1, currentBranch: long });
    const label = screen.getByTitle(long);
    expect(label.tagName).toBe("SPAN");
    expect(label).toHaveTextContent(long);
    expect(label).toHaveClass("truncate");
  });

  it("gives each branch and tag row a title carrying its full name", async () => {
    branches.value = [
      { name: "origin/feature/admin-settings-redesign", is_head: false, is_remote: true },
      { name: "origin/fix/backport-watch-limit", is_head: false, is_remote: true },
    ] as BranchInfo[];
    tags.value = ["v1.2.3-release-candidate-final"];

    renderSwitcher({ repoId: 1, currentBranch: "main" });
    fireEvent.click(screen.getByTitle("Switch branch or tag"));

    await waitFor(() => {
      expect(screen.getByTitle("origin/feature/admin-settings-redesign")).toHaveClass("truncate");
    });
    expect(screen.getByTitle("origin/fix/backport-watch-limit")).toHaveClass("truncate");
    expect(screen.getByTitle("v1.2.3-release-candidate-final")).toHaveClass("truncate");
  });
});

describe('BranchSwitcher "Base it on" picker (#306 follow-up)', () => {
  beforeEach(() => {
    branches.value = [];
    tags.value = [];
    createBranch.mockClear();
  });

  /** Open the dropdown and switch to the create-branch form. */
  async function openCreateForm(name: string) {
    fireEvent.click(screen.getByTitle("main"));
    fireEvent.click(await screen.findByText("Create branch…"));
    fireEvent.change(screen.getByPlaceholderText("branch-name"), { target: { value: name } });
  }

  it("maps the HEAD sentinel back to no source ref", async () => {
    // The picker is a Radix Select, which rejects "" as an item value, so
    // "base on HEAD" travels as a sentinel. If that sentinel leaked to the
    // backend the branch would be created from a ref literally named
    // "__head__" rather than from HEAD.
    //
    // The selection must *move away* from HEAD and back again: the form can
    // already be sitting on HEAD, and Radix fires no change when you re-pick
    // the current value — so picking HEAD directly would assert nothing.
    branches.value = [
      { name: "main", is_head: true, is_remote: false },
      { name: "develop", is_head: false, is_remote: false },
    ] as BranchInfo[];
    renderSwitcher({ repoId: 1, currentBranch: "main" });
    await openCreateForm("feat/x");
    const picker = screen.getByRole("combobox", { name: "Base it on" });

    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("option", { name: "develop" }));
    // Proves the selection actually moved, so the step below is a real change.
    await waitFor(() => expect(picker).toHaveTextContent("develop"));

    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("option", { name: "Current branch (HEAD)" }));
    await waitFor(() => expect(picker).toHaveTextContent("Current branch (HEAD)"));

    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
    await waitFor(() => expect(createBranch).toHaveBeenCalledTimes(1));
    expect(createBranch).toHaveBeenCalledWith(1, "feat/x", undefined);
  });

  it("sends the chosen ref when the user picks an explicit source branch", async () => {
    branches.value = [
      { name: "main", is_head: true, is_remote: false },
      { name: "develop", is_head: false, is_remote: false },
    ] as BranchInfo[];
    renderSwitcher({ repoId: 1, currentBranch: "main" });
    await openCreateForm("feat/y");
    const picker = screen.getByRole("combobox", { name: "Base it on" });

    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("option", { name: "develop" }));
    await waitFor(() => expect(picker).toHaveTextContent("develop"));

    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
    await waitFor(() => expect(createBranch).toHaveBeenCalledTimes(1));
    expect(createBranch).toHaveBeenCalledWith(1, "feat/y", "develop");
  });
});
