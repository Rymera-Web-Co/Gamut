import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import type { Group } from "@/lib/ipc";
import { useUiStore } from "@/store/ui";

// The popup's close control kills the backend PTY through the ipc bridge; capture
// the call and stub the fire-and-forget registry report the store emits on every
// terminal mutation (there is no Tauri backend under jsdom).
const terminalKill = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    terminalKill,
    terminalRegistryReport: vi.fn(() => Promise.resolve()),
  },
}));

import { TerminalMenu } from "./GroupRail";

function group(id: number, name: string): Group {
  return {
    id,
    name,
    parent_id: null,
    sort: id,
    icon: null,
    is_default: id === 1,
    folder_path: null,
    last_scan_at: null,
    root_repo_id: null,
  };
}

/** Seed the store's terminal layout and open the popup, returning its content. */
function openMenu(groups: Group[]) {
  const { container } = render(<TerminalMenu groups={groups} />);
  // The toggle opens the popover on hover (openNow('hover')).
  const toggle = container.querySelector("button")!;
  fireEvent.mouseEnter(toggle);
  return screen.getByRole("menu", { name: "Open terminals" });
}

describe("TerminalMenu close control (#280)", () => {
  beforeEach(() => {
    terminalKill.mockClear();
    useUiStore.setState({
      activeGroupId: 1,
      terminalOpen: true,
      termActivity: {},
      terminals: {
        1: {
          activeTabId: "tab-a1",
          tabs: [
            {
              id: "tab-a1",
              title: "alpha-1",
              panes: [
                { id: "term-1", cwd: "/repo" },
                { id: "term-2", cwd: "/repo" },
              ],
              activePaneId: "term-1",
            },
            {
              id: "tab-a2",
              title: "alpha-2",
              panes: [{ id: "term-3", cwd: "/repo" }],
              activePaneId: "term-3",
            },
          ],
        },
        2: {
          activeTabId: "tab-b1",
          tabs: [
            {
              id: "tab-b1",
              title: "beta-1",
              panes: [{ id: "term-4", cwd: "/other" }],
              activePaneId: "term-4",
            },
          ],
        },
      },
    });
  });

  it("renders a keyboard-reachable close button per terminal row (A1, A2)", () => {
    const menu = openMenu([group(1, "Alpha"), group(2, "Beta")]);
    const closers = within(menu).getAllByLabelText(/^Close .* terminal$/);
    // One per open tab across both groups.
    expect(closers).toHaveLength(3);
    expect(within(menu).getByLabelText("Close alpha-1 terminal")).toBeInTheDocument();
    for (const btn of closers) {
      // Genuinely keyboard-reachable (a real button that can take focus), not a
      // hover-only affordance — assert the behavior, not the styling classes.
      expect(btn.tagName).toBe("BUTTON");
      (btn as HTMLElement).focus();
      expect(btn).toHaveFocus();
    }
  });

  it("kills every pane's PTY then removes the tab from the store (A3, A4)", () => {
    const menu = openMenu([group(1, "Alpha"), group(2, "Beta")]);
    fireEvent.click(within(menu).getByLabelText("Close alpha-1 terminal"));

    // Both panes of the two-pane tab are killed.
    expect(terminalKill).toHaveBeenCalledTimes(2);
    expect(terminalKill).toHaveBeenCalledWith("term-1");
    expect(terminalKill).toHaveBeenCalledWith("term-2");

    // The tab is dropped and the store re-selects a surviving tab.
    const g1 = useUiStore.getState().terminals[1];
    expect(g1.tabs.map((t) => t.id)).toEqual(["tab-a2"]);
    expect(g1.activeTabId).toBe("tab-a2");
  });

  it("does not navigate (jump) when closing, and the popup stays open (A5, A7)", () => {
    const menu = openMenu([group(1, "Alpha"), group(2, "Beta")]);
    fireEvent.click(within(menu).getByLabelText("Close beta-1 terminal"));

    // jump() would setActiveGroup(2) + selectTerminalTab + setOpen(false); none happen.
    expect(useUiStore.getState().activeGroupId).toBe(1);
    // Beta's only tab was closed, so its section drops out (A6) but the menu remains.
    expect(screen.getByRole("menu", { name: "Open terminals" })).toBeInTheDocument();
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
    expect(useUiStore.getState().terminals[2].tabs).toHaveLength(0);
  });

  it("shows the empty state once the last terminal is closed (A6, A7)", () => {
    useUiStore.setState({
      terminals: {
        2: {
          activeTabId: "tab-b1",
          tabs: [
            {
              id: "tab-b1",
              title: "beta-1",
              panes: [{ id: "term-4", cwd: "/other" }],
              activePaneId: "term-4",
            },
          ],
        },
      },
    });
    const menu = openMenu([group(2, "Beta")]);
    fireEvent.click(within(menu).getByLabelText("Close beta-1 terminal"));
    expect(screen.getByText("No terminals open")).toBeInTheDocument();
  });

  it("still jumps to a terminal when the row itself is clicked (A8 regression)", () => {
    const menu = openMenu([group(1, "Alpha"), group(2, "Beta")]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /beta-1/ }));

    const state = useUiStore.getState();
    expect(state.activeGroupId).toBe(2);
    expect(state.terminalOpen).toBe(true);
    expect(state.terminals[2].activeTabId).toBe("tab-b1");
    expect(terminalKill).not.toHaveBeenCalled();
  });
});
