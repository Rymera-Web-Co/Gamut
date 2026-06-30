import { describe, it, expect } from "vitest";
import type { Group, Repo } from "@/lib/ipc";
import { repoInGroup, repoPathRelativeToGroupFolder, visibleRepos } from "@/lib/groupRepos";

function makeRepo(id: number, group_ids: number[]): Repo {
  return {
    id,
    path: `/repos/${id}`,
    name: `repo-${id}`,
    default_branch: "main",
    last_opened: null,
    created_at: "2024-01-01 00:00:00",
    tag_ids: [],
    group_ids,
    missing: false,
    is_git_repo: true,
  };
}

function makeGroup(id: number, is_default: boolean): Group {
  return {
    id,
    name: is_default ? "All" : `group-${id}`,
    parent_id: null,
    sort: 0,
    icon: null,
    is_default,
    folder_path: null,
    last_scan_at: null,
    root_repo_id: null,
  };
}

const defaultGroup = makeGroup(1, true);
const teamGroup = makeGroup(2, false);

describe("repoInGroup", () => {
  it("returns false when no group is given", () => {
    expect(repoInGroup(makeRepo(1, []), undefined)).toBe(false);
  });

  it("the default group owns repos with no explicit group", () => {
    expect(repoInGroup(makeRepo(1, []), defaultGroup)).toBe(true);
    expect(repoInGroup(makeRepo(2, [2]), defaultGroup)).toBe(false);
  });

  it("a non-default group owns only repos assigned to it", () => {
    expect(repoInGroup(makeRepo(1, [2]), teamGroup)).toBe(true);
    expect(repoInGroup(makeRepo(2, [3]), teamGroup)).toBe(false);
    expect(repoInGroup(makeRepo(3, []), teamGroup)).toBe(false);
  });
});

describe("visibleRepos", () => {
  it("filters to the group's repos while preserving order", () => {
    const repos = [makeRepo(1, []), makeRepo(2, [2]), makeRepo(3, [])];
    expect(visibleRepos(repos, defaultGroup).map((r) => r.id)).toEqual([1, 3]);
    expect(visibleRepos(repos, teamGroup).map((r) => r.id)).toEqual([2]);
  });

  it("returns nothing for an undefined group", () => {
    expect(visibleRepos([makeRepo(1, [])], undefined)).toEqual([]);
  });
});

describe("repoPathRelativeToGroupFolder", () => {
  it("returns null when the group isn't folder-bound", () => {
    expect(repoPathRelativeToGroupFolder("/work/foo/bar", null)).toBeNull();
  });

  it("returns the repo path relative to the group folder", () => {
    expect(repoPathRelativeToGroupFolder("/work/foo/bar", "/work")).toBe("foo/bar");
    expect(repoPathRelativeToGroupFolder("/work/foo", "/work")).toBe("foo");
  });

  it("returns an empty string when the repo is the group folder root", () => {
    expect(repoPathRelativeToGroupFolder("/work", "/work")).toBe("");
  });

  it("returns null when the repo isn't under the group folder", () => {
    expect(repoPathRelativeToGroupFolder("/elsewhere/foo", "/work")).toBeNull();
    // A sibling whose name merely shares a prefix must not match.
    expect(repoPathRelativeToGroupFolder("/work-other/foo", "/work")).toBeNull();
  });

  it("tolerates trailing slashes and mixed separators", () => {
    expect(repoPathRelativeToGroupFolder("/work/foo/bar/", "/work/")).toBe("foo/bar");
    expect(repoPathRelativeToGroupFolder("C:\\work\\foo\\bar", "C:\\work")).toBe("foo/bar");
  });
});
