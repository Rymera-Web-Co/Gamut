import { beforeEach, describe, expect, it } from "vitest";

import { useUiStore } from "@/store/ui";
import { takePendingCommand } from "./pendingCommands";
import { fileReference, sendToActiveTerminal } from "./sendToTerminal";

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
