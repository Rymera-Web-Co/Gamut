import { describe, expect, it } from "vitest";

import { parseStoredTerminals } from "./ui";

/** A minimal well-formed persisted blob for one group with one tab/pane. */
function blob(overrides?: Record<string, unknown>) {
  return JSON.stringify({
    nextTermId: 5,
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
    ...overrides,
  });
}

describe("parseStoredTerminals", () => {
  it("round-trips a valid layout", () => {
    const { terminals, nextTermId } = parseStoredTerminals(blob());
    expect(terminals[1].tabs).toHaveLength(1);
    expect(terminals[1].activeTabId).toBe("tab-3");
    expect(terminals[1].tabs[0].panes[0].cwd).toBe("/repo");
    // Counter is bumped past every restored id so new tabs can't collide.
    expect(nextTermId).toBe(4);
  });

  it("returns empty on corrupt JSON", () => {
    expect(parseStoredTerminals("{not json")).toEqual({ terminals: {}, nextTermId: 1 });
  });

  it("returns empty when the shape is wrong", () => {
    expect(parseStoredTerminals(JSON.stringify({ terminals: [] }))).toEqual({
      terminals: {},
      nextTermId: 1,
    });
  });

  it("drops malformed tabs and groups with no valid tabs", () => {
    const raw = JSON.stringify({
      terminals: {
        1: {
          activeTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              title: "ok",
              panes: [{ id: "term-1", cwd: "/a" }],
              activePaneId: "term-1",
            },
            { id: "tab-2", title: "bad", panes: [] }, // no panes → dropped
            {
              id: "tab-3",
              title: "bad2",
              panes: [{ id: "term-9", cwd: "/b" }],
              activePaneId: "nope",
            },
          ],
        },
        2: { activeTabId: null, tabs: [{ id: "x", title: "y" }] }, // no valid tabs → group dropped
      },
    });
    const { terminals } = parseStoredTerminals(raw);
    expect(Object.keys(terminals)).toEqual(["1"]);
    expect(terminals[1].tabs.map((t) => t.id)).toEqual(["tab-1"]);
  });

  it("repairs an activeTabId that names no surviving tab", () => {
    const raw = JSON.stringify({
      terminals: {
        1: {
          activeTabId: "gone",
          tabs: [
            {
              id: "tab-7",
              title: "t",
              panes: [{ id: "term-7", cwd: "/c" }],
              activePaneId: "term-7",
            },
          ],
        },
      },
    });
    expect(parseStoredTerminals(raw).terminals[1].activeTabId).toBe("tab-7");
  });

  it("computes nextTermId from the largest restored id", () => {
    const raw = JSON.stringify({
      terminals: {
        1: {
          activeTabId: "tab-2",
          tabs: [
            {
              id: "tab-2",
              title: "t",
              panes: [
                { id: "term-2", cwd: "/a" },
                { id: "term-42", cwd: "/b" },
              ],
              activePaneId: "term-2",
            },
          ],
        },
      },
    });
    expect(parseStoredTerminals(raw).nextTermId).toBe(43);
  });
});
