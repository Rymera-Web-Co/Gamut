import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { BranchInfo } from "@/lib/ipc";

// Branch/tag lists are fetched through the ipc bridge; feed fixed data so the
// dropdown renders synchronously without a Tauri backend.
const branches = vi.hoisted(() => ({ value: [] as BranchInfo[] }));
const tags = vi.hoisted(() => ({ value: [] as string[] }));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    listBranches: () => Promise.resolve(branches.value),
    listGitTags: () => Promise.resolve(tags.value),
    checkoutBranch: () => Promise.resolve(),
    createBranch: () => Promise.resolve(),
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
