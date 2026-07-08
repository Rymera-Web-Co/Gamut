import { describe, expect, it } from "vitest";

import type { DirEntry } from "@/lib/ipc";
import {
  basename,
  flattenVisible,
  isInside,
  movablePaths,
  parentDir,
  rangePaths,
  topLevelPaths,
} from "./treeSelection";

function entry(name: string, kind: "dir" | "file"): DirEntry {
  return { name, kind, is_symlink: false, is_ignored: false };
}

// A small fixture tree:
//   src/            (dir)
//     a.ts
//     util/         (dir)
//       b.ts
//   README.md
const TREE: Record<string, DirEntry[]> = {
  "": [entry("src", "dir"), entry("README.md", "file")],
  src: [entry("a.ts", "file"), entry("util", "dir")],
  "src/util": [entry("b.ts", "file")],
};
const getEntries = (dir: string) => TREE[dir];

describe("parentDir / basename", () => {
  it("splits a nested path", () => {
    expect(parentDir("src/util/b.ts")).toBe("src/util");
    expect(basename("src/util/b.ts")).toBe("b.ts");
  });

  it("treats a top-level path as living at the root", () => {
    expect(parentDir("README.md")).toBe("");
    expect(basename("README.md")).toBe("README.md");
  });
});

describe("isInside", () => {
  it("is true for the dir itself and its descendants", () => {
    expect(isInside("src", "src")).toBe(true);
    expect(isInside("src/util", "src")).toBe(true);
  });

  it("is false for siblings and prefix look-alikes", () => {
    expect(isInside("src", "src/util")).toBe(false);
    expect(isInside("src-extra/x", "src")).toBe(false);
  });
});

describe("flattenVisible", () => {
  it("lists only root rows when nothing is open", () => {
    expect(flattenVisible(getEntries, new Set())).toEqual([
      { path: "src", kind: "dir" },
      { path: "README.md", kind: "file" },
    ]);
  });

  it("descends into open dirs in on-screen order", () => {
    const flat = flattenVisible(getEntries, new Set(["src", "src/util"]));
    expect(flat.map((r) => r.path)).toEqual([
      "src",
      "src/a.ts",
      "src/util",
      "src/util/b.ts",
      "README.md",
    ]);
  });

  it("contributes no descendants for an open dir whose children haven't loaded", () => {
    const flat = flattenVisible(() => undefined, new Set(["src"]));
    expect(flat).toEqual([]);
  });
});

describe("rangePaths", () => {
  const flat = flattenVisible(getEntries, new Set(["src", "src/util"]));

  it("returns the inclusive range regardless of endpoint order", () => {
    expect(rangePaths(flat, "src/a.ts", "README.md")).toEqual([
      "src/a.ts",
      "src/util",
      "src/util/b.ts",
      "README.md",
    ]);
    expect(rangePaths(flat, "README.md", "src/a.ts")).toEqual([
      "src/a.ts",
      "src/util",
      "src/util/b.ts",
      "README.md",
    ]);
  });

  it("falls back to just the clicked row when an endpoint isn't visible", () => {
    expect(rangePaths(flat, "gone", "README.md")).toEqual(["README.md"]);
  });
});

describe("topLevelPaths", () => {
  it("drops entries nested under another selected entry", () => {
    // A folder selected together with its children collapses to just the folder.
    expect(topLevelPaths(["src", "src/a.ts", "src/util", "src/util/b.ts"])).toEqual(["src"]);
  });

  it("keeps unrelated siblings", () => {
    expect(topLevelPaths(["src/a.ts", "README.md"])).toEqual(["src/a.ts", "README.md"]);
  });
});

describe("movablePaths", () => {
  it("drops no-op moves into the same parent", () => {
    expect(movablePaths(["src/a.ts"], "src")).toEqual([]);
    expect(movablePaths(["README.md"], "")).toEqual([]);
  });

  it("drops the target itself and its ancestors", () => {
    expect(movablePaths(["src", "src/util"], "src/util")).toEqual([]);
  });

  it("collapses a folder + its descendants to the folder before moving", () => {
    // Dragging `src` and `src/a.ts` into `dest` must move only `src` — moving
    // `src/a.ts` too would fail once `src` (and its child) has relocated.
    expect(movablePaths(["src", "src/a.ts"], "dest")).toEqual(["src"]);
  });

  it("keeps a genuine move", () => {
    expect(movablePaths(["README.md", "src/a.ts"], "src/util")).toEqual([
      "README.md",
      "src/a.ts",
    ]);
  });
});
