import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import type { FileChange } from "@/lib/ipc";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    getSettings: vi.fn(() => Promise.resolve({})),
    setSetting: vi.fn(() => Promise.resolve()),
  },
}));

const FILE: FileChange = {
  path: "src/foo.ts",
  old_path: null,
  status: "modified",
  additions: 1,
  deletions: 0,
};

// Stand in for all the worktree data hooks so the pane renders one unstaged,
// selectable file with a non-binary diff under jsdom.
const noopMutation = { mutate: vi.fn(), isPending: false, variables: undefined };
vi.mock("./api", () => ({
  useWorktreeStatus: () => ({
    isLoading: false,
    isError: false,
    data: { staged: [], unstaged: [FILE] },
  }),
  useWorktreeFileDiff: () => ({
    isLoading: false,
    data: { old_text: "a", new_text: "b", is_binary: false },
  }),
  useStage: () => noopMutation,
  useUnstage: () => noopMutation,
  useDiscard: () => noopMutation,
  useCommit: () => noopMutation,
  useStashPush: () => noopMutation,
  useStashAction: () => noopMutation,
  useStashList: () => ({ data: [] }),
}));

// Irrelevant to the toggle and it pulls in react-query (useRepos) — stub it so
// the pane renders without a QueryClient.
vi.mock("@/components/FileActionsMenu", () => ({
  FileActionsMenu: () => null,
}));

// Capture the options handed to the diff editor, to prove the in-pane toggle
// reaches the rendered editor (not just the store).
const captured = vi.hoisted(() => ({ options: null as Record<string, unknown> | null }));
vi.mock("@/components/MonacoEditor", () => ({
  CodeDiffEditor: ({ options }: { options: Record<string, unknown> }) => {
    captured.options = options;
    return null;
  },
}));

import { DEFAULTS, useSettings } from "@/lib/settings";
import { WorkingTree } from "./WorkingTree";

/** Render the working-tree pane and open the single changed file. */
function openFile() {
  render(<WorkingTree repoId={1} />);
  // The change row is a role="button" carrying the file path as its title.
  fireEvent.click(screen.getByTitle(FILE.path));
}

describe("WorkingTree in-view diff controls (#284)", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettings.setState({ values: { ...DEFAULTS } });
    captured.options = null;
  });

  it("shows the in-view layout + word-wrap controls once a file is open (A2)", () => {
    openFile();
    expect(screen.getByRole("button", { name: "Side by side" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unified" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Word wrap" })).toBeInTheDocument();
  });

  it("toggling layout in the pane reaches the diff editor (A2/A3)", () => {
    openFile();
    expect(captured.options?.renderSideBySide).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Unified" }));
    expect(captured.options?.renderSideBySide).toBe(false);
  });

  it("toggling word wrap in the pane reaches the diff editor (A2/A6)", () => {
    openFile();
    expect(captured.options?.wordWrap).toBe("off");

    fireEvent.click(screen.getByRole("button", { name: "Word wrap" }));
    expect(captured.options?.wordWrap).toBe("on");
  });
});
