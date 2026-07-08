import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirEntry } from "@/lib/ipc";
import { RepoTree, type TreeChanges } from "./RepoTree";

// The tree fixture, keyed by repo-relative directory (root = "").
const TREE: Record<string, DirEntry[]> = {
  "": [entry("a.ts", "file"), entry("b.ts", "file"), entry("src", "dir")],
  src: [entry("c.ts", "file")],
};
function entry(name: string, kind: "dir" | "file"): DirEntry {
  return { name, kind, is_symlink: false, is_ignored: false };
}

const renamePath = vi.fn().mockResolvedValue(undefined);
const deletePath = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/ipc", () => ({
  ipc: {
    listDir: (_repoId: number, path: string) => Promise.resolve(TREE[path] ?? []),
    renamePath: (repoId: number, from: string, to: string) => renamePath(repoId, from, to),
    deletePath: (repoId: number, path: string) => deletePath(repoId, path),
    resolvePath: (_repoId: number, path: string) => Promise.resolve(`/abs/${path}`),
  },
}));

function rect(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    left,
    top,
    right,
    bottom,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

// The window-level pointer events the drag manager listens for.
function win(type: string, x: number, y: number) {
  act(() => {
    window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
  });
}

const NO_CHANGES: TreeChanges = { files: new Map(), dirs: new Set() };

async function renderTree() {
  const onSelect = vi.fn();
  const onRenamed = vi.fn();
  const onDeleted = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seed the directory caches so rows render synchronously.
  for (const [path, entries] of Object.entries(TREE)) {
    client.setQueryData(["dir", 1, path], entries);
  }
  render(
    <QueryClientProvider client={client}>
      <RepoTree
        repoId={1}
        selectedPath={null}
        onSelect={onSelect}
        onDeleted={onDeleted}
        onRenamed={onRenamed}
        changes={NO_CHANGES}
        groupRelativePrefix={null}
      />
    </QueryClientProvider>,
  );
  await screen.findByTitle("a.ts");
  return { onSelect, onRenamed, onDeleted };
}

/** Whether a row (found by its `title`) carries the selection background. */
function isSelected(title: string): boolean {
  return screen.getByTitle(title).classList.contains("bg-[var(--color-accent)]");
}

beforeEach(() => {
  renamePath.mockClear();
  deletePath.mockClear();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  win("pointercancel", 0, 0);
  vi.restoreAllMocks();
});

describe("RepoTree selection", () => {
  it("opens a file and single-selects it on a plain click", async () => {
    const { onSelect } = await renderTree();
    fireEvent.click(screen.getByTitle("a.ts"));
    expect(onSelect).toHaveBeenCalledWith("a.ts");
    expect(isSelected("a.ts")).toBe(true);
    expect(isSelected("b.ts")).toBe(false);
  });

  it("toggles rows into the selection on ⌘/Ctrl-click without opening them", async () => {
    const { onSelect } = await renderTree();
    fireEvent.click(screen.getByTitle("a.ts"));
    onSelect.mockClear();
    fireEvent.click(screen.getByTitle("b.ts"), { ctrlKey: true });
    expect(onSelect).not.toHaveBeenCalled();
    expect(isSelected("a.ts")).toBe(true);
    expect(isSelected("b.ts")).toBe(true);

    // Ctrl-click again removes it from the selection.
    fireEvent.click(screen.getByTitle("b.ts"), { ctrlKey: true });
    expect(isSelected("b.ts")).toBe(false);
  });

  it("selects the range from the anchor on ⇧-click, in on-screen order", async () => {
    await renderTree();
    fireEvent.click(screen.getByTitle("a.ts"));
    fireEvent.click(screen.getByTitle("src"), { shiftKey: true });
    expect(isSelected("a.ts")).toBe(true);
    expect(isSelected("b.ts")).toBe(true);
    expect(isSelected("src")).toBe(true);
  });

  it("moves the active row with the Down arrow", async () => {
    await renderTree();
    fireEvent.click(screen.getByTitle("a.ts"));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    });
    expect(isSelected("b.ts")).toBe(true);
    expect(isSelected("a.ts")).toBe(false);
  });
});

describe("RepoTree drag-to-move", () => {
  it("moves a file into a folder it's dragged onto via ipc.renamePath", async () => {
    const { onRenamed } = await renderTree();
    const aFile = screen.getByTitle("a.ts");
    const srcDir = screen.getByTitle("src");
    aFile.getBoundingClientRect = () => rect(0, 0, 100, 20);
    srcDir.getBoundingClientRect = () => rect(0, 40, 100, 60);

    fireEvent.pointerDown(aFile, { button: 0, clientX: 5, clientY: 10 });
    win("pointermove", 5, 50); // cross the threshold, now over the folder
    win("pointerup", 5, 50);

    await waitFor(() => expect(renamePath).toHaveBeenCalledWith(1, "a.ts", "src/a.ts"));
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith("a.ts", "src/a.ts"));
  });

  it("does not move a file dropped back onto its own parent (no-op)", async () => {
    await renderTree();
    const aFile = screen.getByTitle("a.ts");
    const bFile = screen.getByTitle("b.ts");
    aFile.getBoundingClientRect = () => rect(0, 0, 100, 20);
    bFile.getBoundingClientRect = () => rect(0, 20, 100, 40);

    // a.ts and b.ts are both at the root; dropping one on the other is a no-op
    // (a file isn't a folder, and root→root wouldn't move anything).
    fireEvent.pointerDown(aFile, { button: 0, clientX: 5, clientY: 10 });
    win("pointermove", 5, 30);
    win("pointerup", 5, 30);

    expect(renamePath).not.toHaveBeenCalled();
  });
});
