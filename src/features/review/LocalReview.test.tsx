import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import type { FileChange } from "@/lib/ipc";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    getSettings: vi.fn(() => Promise.resolve({})),
    setSetting: vi.fn(() => Promise.resolve()),
  },
}));

// The review data hooks talk to the git backend; stand them in so the pane can
// render a single selectable file with a non-binary diff under jsdom.
const FILE: FileChange = {
  path: "src/foo.ts",
  old_path: null,
  status: "modified",
  additions: 1,
  deletions: 0,
};
vi.mock("./api", () => ({
  useReviewFiles: () => ({
    isLoading: false,
    isError: false,
    data: { files: [FILE], base_label: "main", head_label: "feature" },
  }),
  useReviewFileDiff: () => ({
    isLoading: false,
    data: { old_text: "a", new_text: "b", is_binary: false },
  }),
  useMentionables: () => ({ data: [] }),
  usePrComment: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/store/reviewDrafts", () => ({
  useReviewDrafts: (selector: (s: unknown) => unknown) => selector({ add: vi.fn() }),
  useDraftsFor: () => [],
}));

// Irrelevant to the toggle and it pulls in react-query (useRepos) via
// useGroupRelativePrefix — stub it so the pane renders without a QueryClient.
vi.mock("@/components/FileActionsMenu", () => ({
  FileActionsMenu: () => null,
}));

// Capture the options the diff editor is handed, so the test can prove the
// in-pane toggle actually reaches the rendered editor (not just the store).
const captured = vi.hoisted(() => ({ options: null as Record<string, unknown> | null }));
vi.mock("@/components/MonacoEditor", () => ({
  CodeDiffEditor: ({ options }: { options: Record<string, unknown> }) => {
    captured.options = options;
    return null;
  },
}));

import { DEFAULTS, useSettings } from "@/lib/settings";
import { LocalReview } from "./LocalReview";

/** Render the branch-review pane and open the single file so the header shows. */
function openFile() {
  render(<LocalReview repoId={1} source="branch" />);
  fireEvent.click(screen.getByTitle(FILE.path));
}

describe("LocalReview in-view diff controls (#284)", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettings.setState({ values: { ...DEFAULTS } });
    captured.options = null;
  });

  it("shows the in-view layout + word-wrap controls once a file is open (A1)", () => {
    openFile();
    expect(screen.getByRole("button", { name: "Side by side" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unified" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Word wrap" })).toBeInTheDocument();
  });

  it("toggling layout in the pane reaches the diff editor (A3/A4/A8)", () => {
    openFile();
    // Default: side-by-side.
    expect(captured.options?.renderSideBySide).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Unified" }));
    expect(captured.options?.renderSideBySide).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
    expect(captured.options?.renderSideBySide).toBe(true);
  });

  it("toggling word wrap in the pane reaches the diff editor (A5/A6)", () => {
    openFile();
    expect(captured.options?.wordWrap).toBe("off");

    fireEvent.click(screen.getByRole("button", { name: "Word wrap" }));
    expect(captured.options?.wordWrap).toBe("on");
  });
});
