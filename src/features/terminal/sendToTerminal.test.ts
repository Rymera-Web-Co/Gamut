import { beforeEach, describe, expect, it } from "vitest";

import { useUiStore } from "@/store/ui";
import { takePendingCommand } from "./pendingCommands";
import {
  clipboardHasFiles,
  fileReference,
  filePathsForShell,
  sendToActiveTerminal,
} from "./sendToTerminal";

describe("fileReference", () => {
  it("returns the bare path when no lines are given", () => {
    expect(fileReference("src/foo.ts")).toBe("src/foo.ts");
  });

  it("appends a single line anchor for a caret / one-line selection", () => {
    expect(fileReference("src/foo.ts", 12)).toBe("src/foo.ts#L12");
  });

  it("uses a GitHub-style range for a multi-line selection", () => {
    expect(fileReference("src/foo.ts", 12, 20)).toBe("src/foo.ts#L12-L20");
  });

  it("collapses to a single anchor when start and end match", () => {
    expect(fileReference("src/foo.ts", 12, 12)).toBe("src/foo.ts#L12");
  });

  it("ignores an end line that is before the start", () => {
    expect(fileReference("src/foo.ts", 12, 5)).toBe("src/foo.ts#L12");
  });

  it("quotes the token when the path contains a space", () => {
    expect(fileReference("src/my file.ts", 1, 2)).toBe('"src/my file.ts#L1-L2"');
    expect(fileReference("src/my file.ts")).toBe('"src/my file.ts"');
  });
});

describe("filePathsForShell", () => {
  it("returns a bare path for a single space-free file", () => {
    expect(filePathsForShell(["/Users/me/repo/file.txt"])).toBe("/Users/me/repo/file.txt");
  });

  it("quotes a path that contains spaces so it survives as one argument", () => {
    expect(filePathsForShell(["/Users/me/My Repo/file.txt"])).toBe('"/Users/me/My Repo/file.txt"');
  });

  it("joins multiple dropped paths with spaces, escaping each independently", () => {
    expect(filePathsForShell(["/a/one.txt", "/b/two three.txt", "/c/four.txt"])).toBe(
      '/a/one.txt "/b/two three.txt" /c/four.txt',
    );
  });

  it("handles a Windows path with spaces the same way", () => {
    expect(filePathsForShell(["C:\\Users\\me\\My Docs\\a.txt"])).toBe(
      '"C:\\Users\\me\\My Docs\\a.txt"',
    );
  });

  it("returns an empty string for no paths", () => {
    expect(filePathsForShell([])).toBe("");
  });
});

describe("clipboardHasFiles", () => {
  // Minimal DataTransfer stand-in: only the three fields the helper reads.
  const dt = (over: {
    files?: number;
    types?: string[];
    items?: Array<{ kind: string }>;
  }): DataTransfer =>
    ({
      files: { length: over.files ?? 0 },
      types: over.types ?? [],
      items: over.items ?? [],
    }) as unknown as DataTransfer;

  it("is true when a File entry is present", () => {
    expect(clipboardHasFiles(dt({ files: 1 }))).toBe(true);
  });

  it("is true when the types list advertises Files", () => {
    expect(clipboardHasFiles(dt({ types: ["Files"] }))).toBe(true);
  });

  it("is true when an item is of kind 'file'", () => {
    expect(clipboardHasFiles(dt({ items: [{ kind: "file" }] }))).toBe(true);
  });

  it("is false for a plain-text paste (no file signals)", () => {
    expect(clipboardHasFiles(dt({ types: ["text/plain"], items: [{ kind: "string" }] }))).toBe(
      false,
    );
  });
});

describe("sendToActiveTerminal", () => {
  beforeEach(() => {
    useUiStore.setState({ activeGroupId: 1, terminals: {}, terminalOpen: false });
  });

  it("queues the text against the active pane and reveals it", () => {
    useUiStore.setState({
      terminals: {
        1: {
          activeTabId: "tab-3",
          tabs: [
            {
              id: "tab-3",
              title: "gamut",
              panes: [{ id: "term-3", cwd: "/repo" }],
              activePaneId: "term-3",
            },
          ],
        },
      },
    });

    sendToActiveTerminal("src/foo.ts#L1");

    // Staged as editable input (no trailing CR) and the panel is revealed.
    expect(takePendingCommand("term-3")).toBe("src/foo.ts#L1");
    expect(useUiStore.getState().terminalOpen).toBe(true);
  });

  it("opens a terminal when the active group has none", () => {
    sendToActiveTerminal("src/bar.ts");

    const group = useUiStore.getState().terminals[1];
    expect(group?.tabs).toHaveLength(1);
    const paneId = group!.tabs[0].activePaneId;
    expect(takePendingCommand(paneId)).toBe("src/bar.ts");
    expect(useUiStore.getState().terminalOpen).toBe(true);
  });

  it("does nothing when there is no active group", () => {
    useUiStore.setState({ activeGroupId: null });
    sendToActiveTerminal("src/foo.ts");
    expect(useUiStore.getState().terminalOpen).toBe(false);
  });
});
