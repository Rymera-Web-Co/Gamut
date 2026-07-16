import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { BranchInfo } from "@/lib/ipc";

// Branch/tag lists come through the ipc bridge; feed fixed data so the dropdown
// renders without a Tauri backend. checkoutBranch is deliberately absent — the
// picker is read-only and must never call it.
const branches = vi.hoisted(() => ({ value: [] as BranchInfo[] }));
const tags = vi.hoisted(() => ({ value: [] as string[] }));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    listBranches: () => Promise.resolve(branches.value),
    listGitTags: () => Promise.resolve(tags.value),
  },
}));

import { RefPicker } from "./RefPicker";

function renderPicker(props: {
  repoId: number;
  currentBranch?: string | null;
  value: string | null;
  onChange: (revspec: string | null) => void;
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RefPicker {...props} />
    </QueryClientProvider>,
  );
}

describe("RefPicker (#254)", () => {
  beforeEach(() => {
    branches.value = [];
    tags.value = [];
  });

  it("shows the checked-out branch on the trigger when viewing HEAD", () => {
    renderPicker({ repoId: 1, currentBranch: "main", value: null, onChange: () => {} });
    expect(screen.getByTitle("main")).toHaveTextContent("main");
  });

  it("shows the peeked ref on the trigger, not the checked-out branch", () => {
    renderPicker({ repoId: 1, currentBranch: "main", value: "v1.0", onChange: () => {} });
    expect(screen.getByTitle("v1.0")).toHaveTextContent("v1.0");
  });

  it("selecting a branch reports its name via onChange (no checkout)", async () => {
    branches.value = [
      { name: "main", is_head: true, is_remote: false },
      { name: "feature/x", is_head: false, is_remote: false },
    ] as BranchInfo[];
    tags.value = ["v1.0"];
    const onChange = vi.fn();

    renderPicker({ repoId: 1, currentBranch: "main", value: null, onChange });
    fireEvent.click(screen.getByTitle("View another branch or tag's history (read-only)"));

    await waitFor(() => expect(screen.getByTitle("feature/x")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("feature/x"));
    expect(onChange).toHaveBeenCalledWith("feature/x");
  });

  it("selecting a tag reports its name via onChange", async () => {
    tags.value = ["v1.0"];
    const onChange = vi.fn();

    renderPicker({ repoId: 1, currentBranch: "main", value: null, onChange });
    fireEvent.click(screen.getByTitle("View another branch or tag's history (read-only)"));

    await waitFor(() => expect(screen.getByTitle("v1.0")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("v1.0"));
    expect(onChange).toHaveBeenCalledWith("v1.0");
  });

  it("the 'Current branch (HEAD)' entry returns to HEAD via onChange(null)", async () => {
    const onChange = vi.fn();
    renderPicker({ repoId: 1, currentBranch: "main", value: "v1.0", onChange });
    fireEvent.click(screen.getByTitle("View another branch or tag's history (read-only)"));

    await waitFor(() => expect(screen.getByText("Current branch (HEAD)")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Current branch (HEAD)"));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
