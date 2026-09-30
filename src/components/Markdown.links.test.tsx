import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn(() => Promise.resolve()),
  openPath: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
  resolveTerminalPath: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: mocks.openUrl,
  openPath: mocks.openPath,
  revealItemInDir: mocks.revealItemInDir,
}));
vi.mock("@/lib/ipc", () => ({
  ipc: { resolveTerminalPath: mocks.resolveTerminalPath, githubFetchImage: vi.fn() },
}));

import { Markdown } from "@/components/Markdown";
import { useUiStore } from "@/store/ui";

const BASE = { baseDir: "/r/repo/docs" };

function clickLink(md: string, localLinks?: { baseDir: string }) {
  const { container } = render(<Markdown localLinks={localLinks}>{md}</Markdown>);
  const link = container.querySelector("a");
  if (!link) throw new Error("no link rendered");
  fireEvent.click(link);
  return link;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// Local file links in a repo Markdown preview open like terminal file links
// (#344): an in-repo text file in the Files view, anything else revealed in the
// file manager. Web URLs still open in the browser.
describe("Markdown local links", () => {
  it("reveals an out-of-repo file link in the file manager", async () => {
    mocks.resolveTerminalPath.mockResolvedValueOnce({
      abs_path: "/tmp/out/run.sh",
      is_dir: false,
      repo_id: null,
      rel_path: null,
    });
    clickLink("[log](/tmp/out/run.sh)", BASE);
    await waitFor(() => expect(mocks.revealItemInDir).toHaveBeenCalledWith("/tmp/out/run.sh"));
    expect(mocks.resolveTerminalPath).toHaveBeenCalledWith("/tmp/out/run.sh", "/r/repo/docs");
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it("opens an in-repo relative link in the Files view", async () => {
    const calls: string[] = [];
    useUiStore.setState({
      setActiveRepo: vi.fn((id: number | null) => void calls.push(`repo:${id}`)),
      showView: vi.fn((view) => void calls.push(`view:${view}`)),
      setFilesPath: vi.fn((path: string | null) => void calls.push(`path:${path}`)),
    });
    mocks.resolveTerminalPath.mockResolvedValueOnce({
      abs_path: "/r/repo/guide/a.md",
      is_dir: false,
      repo_id: 3,
      rel_path: "guide/a.md",
    });
    clickLink("[guide](../guide/a.md#intro)", BASE);
    await waitFor(() => expect(calls).toEqual(["repo:3", "view:files", "path:guide/a.md"]));
    expect(mocks.resolveTerminalPath).toHaveBeenCalledWith("../guide/a.md", "/r/repo/docs");
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it("keeps a file: link and resolves its decoded path", async () => {
    mocks.resolveTerminalPath.mockResolvedValueOnce(null);
    const link = clickLink("[f](file:///tmp/My%20File.log)", BASE);
    expect(link.getAttribute("href")).toBe("file:///tmp/My%20File.log");
    await waitFor(() =>
      expect(mocks.resolveTerminalPath).toHaveBeenCalledWith("/tmp/My File.log", "/r/repo/docs"),
    );
  });

  it("does nothing for a link to a missing file", async () => {
    mocks.resolveTerminalPath.mockResolvedValueOnce(null);
    clickLink("[gone](missing.md)", BASE);
    await waitFor(() => expect(mocks.resolveTerminalPath).toHaveBeenCalled());
    expect(mocks.revealItemInDir).not.toHaveBeenCalled();
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it("does nothing when resolving the link fails", async () => {
    mocks.resolveTerminalPath.mockRejectedValueOnce(new Error("boom"));
    clickLink("[x](x.md)", BASE);
    await waitFor(() => expect(mocks.resolveTerminalPath).toHaveBeenCalled());
    expect(mocks.revealItemInDir).not.toHaveBeenCalled();
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it.each(["https://example.com/a.md", "http://example.com/", "mailto:me@example.com"])(
    "opens %s in the browser, not as a path",
    (href) => {
      clickLink(`[web](${href})`, BASE);
      expect(mocks.openUrl).toHaveBeenCalledWith(href);
      expect(mocks.resolveTerminalPath).not.toHaveBeenCalled();
    },
  );

  it("does not resolve a fragment-only link as a path", () => {
    clickLink("[top](#heading)", BASE);
    expect(mocks.resolveTerminalPath).not.toHaveBeenCalled();
    expect(mocks.revealItemInDir).not.toHaveBeenCalled();
    expect(mocks.openPath).not.toHaveBeenCalled();
  });
});

// Remote content (PR / issue bodies) has no local links: everything goes to the
// browser, and `file:` hrefs stay stripped.
describe("Markdown links without localLinks", () => {
  it("sends a path-like href to the browser opener, unchanged", () => {
    clickLink("[doc](../docs/a.md)");
    expect(mocks.openUrl).toHaveBeenCalledWith("../docs/a.md");
    expect(mocks.resolveTerminalPath).not.toHaveBeenCalled();
  });

  it("strips file: hrefs", () => {
    const { container } = render(<Markdown>{"[f](file:///etc/passwd)"}</Markdown>);
    expect(container.innerHTML).not.toContain("file:");
  });
});
