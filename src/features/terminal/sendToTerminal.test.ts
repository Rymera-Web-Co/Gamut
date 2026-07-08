import { beforeEach, describe, expect, it } from "vitest";

import { useUiStore } from "@/store/ui";
import { takePendingCommand } from "./pendingCommands";
import {
  fileReference,
  filePathsForShell,
  sendToActiveTerminal,
  shellQuotePath,
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

  it("single-quotes the token when the path contains a space", () => {
    expect(fileReference("src/my file.ts", 1, 2)).toBe("'src/my file.ts#L1-L2'");
    expect(fileReference("src/my file.ts")).toBe("'src/my file.ts'");
  });
});

describe("shellQuotePath", () => {
  it("leaves a bare safe path unquoted", () => {
    expect(shellQuotePath("/Users/me/repo/file.txt")).toBe("/Users/me/repo/file.txt");
  });

  it("keeps a mid-word # (line anchor) bare but quotes a leading #", () => {
    expect(shellQuotePath("src/foo.ts#L12")).toBe("src/foo.ts#L12");
    expect(shellQuotePath("#weird.txt")).toBe("'#weird.txt'");
  });

  it("single-quotes shell metacharacters so they can't be interpreted", () => {
    // `;`, command substitution, backticks, pipes, `!`, quotes and backslashes
    // all reach the shell literally instead of triggering execution or splitting.
    expect(shellQuotePath("/tmp/foo; rm -rf ~")).toBe("'/tmp/foo; rm -rf ~'");
    expect(shellQuotePath("/tmp/$(malicious)")).toBe("'/tmp/$(malicious)'");
    expect(shellQuotePath("/tmp/`whoami`")).toBe("'/tmp/`whoami`'");
    expect(shellQuotePath("/tmp/a|b")).toBe("'/tmp/a|b'");
    expect(shellQuotePath('/tmp/a"b.txt')).toBe("'/tmp/a\"b.txt'");
    expect(shellQuotePath("C:\\Users\\me\\a.txt")).toBe("'C:\\Users\\me\\a.txt'");
  });

  it("escapes an embedded single quote with the POSIX '\\'' sequence", () => {
    expect(shellQuotePath("/tmp/it's mine.txt")).toBe("'/tmp/it'\\''s mine.txt'");
  });
});

describe("filePathsForShell", () => {
  it("returns a bare path for a single space-free file", () => {
    expect(filePathsForShell(["/Users/me/repo/file.txt"])).toBe("/Users/me/repo/file.txt");
  });

  it("quotes a path that contains spaces so it survives as one argument", () => {
    expect(filePathsForShell(["/Users/me/My Repo/file.txt"])).toBe("'/Users/me/My Repo/file.txt'");
  });

  it("joins multiple dropped paths with spaces, escaping each independently", () => {
    expect(filePathsForShell(["/a/one.txt", "/b/two three.txt", "/c/four.txt"])).toBe(
      "/a/one.txt '/b/two three.txt' /c/four.txt",
    );
  });

  it("handles a Windows path with spaces the same way", () => {
    expect(filePathsForShell(["C:\\Users\\me\\My Docs\\a.txt"])).toBe(
      "'C:\\Users\\me\\My Docs\\a.txt'",
    );
  });

  it("neutralises a dropped path crafted to inject a command", () => {
    expect(filePathsForShell(["/tmp/$(rm -rf ~)", "/b/normal.txt"])).toBe(
      "'/tmp/$(rm -rf ~)' /b/normal.txt",
    );
  });

  it("returns an empty string for no paths", () => {
    expect(filePathsForShell([])).toBe("");
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
