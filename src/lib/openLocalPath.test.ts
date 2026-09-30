import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openPath: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
  resolveTerminalPath: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: mocks.openPath,
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: mocks.revealItemInDir,
}));
vi.mock("@/lib/ipc", () => ({ ipc: { resolveTerminalPath: mocks.resolveTerminalPath } }));

import type { ResolvedTermPath } from "@/lib/ipc";
import { useUiStore } from "@/store/ui";
import { localLinkPath, markdownLinkBase, openLocalPath, openResolvedPath } from "./openLocalPath";

/** Replace the store's navigation actions with spies that log their call order. */
function spyNavigation() {
  const calls: string[] = [];
  useUiStore.setState({
    setActiveRepo: vi.fn((id: number | null) => void calls.push(`repo:${id}`)),
    showView: vi.fn((view) => void calls.push(`view:${view}`)),
    setFilesPath: vi.fn((path: string | null) => void calls.push(`path:${path}`)),
  });
  return calls;
}

const file = (over: Partial<ResolvedTermPath>): ResolvedTermPath => ({
  abs_path: "/tmp/out/run.sh",
  is_dir: false,
  repo_id: null,
  rel_path: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("openResolvedPath (#344)", () => {
  it("reveals an out-of-repo file instead of opening it", () => {
    const calls = spyNavigation();
    openResolvedPath(file({}));
    expect(mocks.revealItemInDir).toHaveBeenCalledWith("/tmp/out/run.sh");
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("reveals an out-of-repo binary too — never the default app", () => {
    openResolvedPath(file({ abs_path: "/tmp/out/report.pdf" }));
    expect(mocks.revealItemInDir).toHaveBeenCalledWith("/tmp/out/report.pdf");
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it("opens an in-repo text file in the Files view, repo first and path last", () => {
    const calls = spyNavigation();
    openResolvedPath(file({ abs_path: "/r/src/a.ts", repo_id: 7, rel_path: "src/a.ts" }));
    expect(calls).toEqual(["repo:7", "view:files", "path:src/a.ts"]);
    expect(mocks.revealItemInDir).not.toHaveBeenCalled();
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it("opens an in-repo image in the Files view", () => {
    const calls = spyNavigation();
    openResolvedPath(file({ abs_path: "/r/logo.png", repo_id: 7, rel_path: "logo.png" }));
    expect(calls).toEqual(["repo:7", "view:files", "path:logo.png"]);
  });

  it("reveals an in-repo binary rather than launching it", () => {
    const calls = spyNavigation();
    openResolvedPath(
      file({ abs_path: "/r/tools/setup.jar", repo_id: 7, rel_path: "tools/setup.jar" }),
    );
    expect(mocks.revealItemInDir).toHaveBeenCalledWith("/r/tools/setup.jar");
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("reveals directories, in or out of a repo", () => {
    openResolvedPath(file({ abs_path: "/r/src", is_dir: true, repo_id: 7, rel_path: "src" }));
    openResolvedPath(file({ abs_path: "/tmp/out", is_dir: true }));
    expect(mocks.revealItemInDir.mock.calls).toEqual([["/r/src"], ["/tmp/out"]]);
    expect(mocks.openPath).not.toHaveBeenCalled();
  });
});

describe("openLocalPath", () => {
  it("resolves against the cwd, then routes the result", async () => {
    mocks.resolveTerminalPath.mockResolvedValueOnce(file({}));
    await openLocalPath("../out/run.sh", "/tmp/work");
    expect(mocks.resolveTerminalPath).toHaveBeenCalledWith("../out/run.sh", "/tmp/work");
    expect(mocks.revealItemInDir).toHaveBeenCalledWith("/tmp/out/run.sh");
  });

  it("does nothing for a path that doesn't exist", async () => {
    mocks.resolveTerminalPath.mockResolvedValueOnce(null);
    await openLocalPath("missing.txt", "/tmp");
    expect(mocks.revealItemInDir).not.toHaveBeenCalled();
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it("does nothing when resolution fails", async () => {
    mocks.resolveTerminalPath.mockRejectedValueOnce(new Error("boom"));
    await openLocalPath("x.txt", "/tmp");
    expect(mocks.revealItemInDir).not.toHaveBeenCalled();
    expect(mocks.openPath).not.toHaveBeenCalled();
  });
});

describe("localLinkPath", () => {
  it.each([
    ["/Users/me/notes.txt", "/Users/me/notes.txt"],
    ["~/notes.txt", "~/notes.txt"],
    ["../docs/a.md", "../docs/a.md"],
    ["a.md", "a.md"],
    ["docs/My%20Notes.md#setup", "docs/My Notes.md"],
    ["docs/a.md?plain=1", "docs/a.md"],
    ["file:///Users/me/My%20File.log", "/Users/me/My File.log"],
    ["file:///C:/Users/me/a.txt", "C:/Users/me/a.txt"],
    ["C:\\Users\\me\\a.txt", "C:\\Users\\me\\a.txt"],
    ["C:/Users/me/a.txt", "C:/Users/me/a.txt"],
    ["a%E0%A4%A.md", "a%E0%A4%A.md"], // malformed escape: kept as written
  ])("treats %s as the local path %s", (href, path) => {
    expect(localLinkPath(href)).toBe(path);
  });

  it.each([
    "https://example.com/a.md",
    "http://example.com",
    "mailto:me@example.com",
    "vscode://file/x",
    "#heading",
    "//example.com/a",
    "",
    "   ",
  ])("does not treat %j as a local path", (href) => {
    expect(localLinkPath(href)).toBeNull();
  });
});

describe("markdownLinkBase", () => {
  it("is the open file's directory under the repo root", () => {
    expect(markdownLinkBase("/r/repo", "docs/guide/a.md")).toEqual({
      baseDir: "/r/repo/docs/guide",
    });
  });

  it("is the repo root for a root-level file, with no trailing separator", () => {
    expect(markdownLinkBase("/r/repo/", "README.md")).toEqual({ baseDir: "/r/repo" });
    expect(markdownLinkBase("C:\\r\\repo\\", "README.md")).toEqual({ baseDir: "C:\\r\\repo" });
  });

  it("is undefined until the repo and the file are known", () => {
    expect(markdownLinkBase(undefined, "a.md")).toBeUndefined();
    expect(markdownLinkBase("/r", null)).toBeUndefined();
  });
});
