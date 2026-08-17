import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Group, Repo } from "@/lib/ipc";
import { useUiStore } from "@/store/ui";

const mocks = vi.hoisted(() => ({
  touchRepo: vi.fn(() => Promise.resolve()),
  groups: [] as Group[],
  repos: [] as Repo[],
}));

vi.mock("@/lib/ipc", () => ({
  ipc: {
    touchRepo: mocks.touchRepo,
    terminalRegistryReport: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock("@/features/repos/api", () => ({
  useGroups: () => ({ data: mocks.groups }),
  useRepos: () => ({ data: mocks.repos }),
}));

import { TerminalHeader } from "./TerminalHeader";

function group(id: number, name: string, overrides: Partial<Group> = {}): Group {
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
    ...overrides,
  };
}

function repo(id: number, name: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/repos/${name}`,
    name,
    default_branch: "main",
    last_opened: null,
    created_at: "",
    tag_ids: [],
    group_ids: [],
    missing: false,
    is_git_repo: true,
    has_worktrees: false,
    auto_pull: false,
    ...overrides,
  };
}

function seedTerminal(cwd = "/repos/alpha") {
  useUiStore.setState({
    activeGroupId: 2,
    terminalOpen: true,
    terminals: {
      2: {
        activeTabId: "tab-1",
        tabs: [
          {
            id: "tab-1",
            title: "alpha shell",
            panes: [{ id: "term-1", cwd }],
            activePaneId: "term-1",
          },
        ],
      },
    },
  });
}

beforeEach(() => {
  mocks.touchRepo.mockClear();
  mocks.groups = [group(1, "Default"), group(2, "Tools")];
  mocks.repos = [repo(1, "alpha", { group_ids: [2] })];
  useUiStore.setState({
    activeGroupId: 2,
    activeRepoId: null,
    activeWorktreePath: null,
    terminalOpen: true,
    terminals: {},
    termActivity: {},
    groupSelections: {},
  });
});

describe("TerminalHeader", () => {
  it("shows a disabled placeholder with no session", () => {
    render(<TerminalHeader />);
    const name = screen.getByText("Terminal").closest("button")!;
    expect(name.disabled).toBe(true);
    expect((screen.getByLabelText("Split terminal right") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByLabelText("Split terminal down") as HTMLButtonElement).disabled).toBe(true);
  });

  it("split down adds a stacked pane (#316)", () => {
    seedTerminal();
    render(<TerminalHeader />);

    fireEvent.click(screen.getByLabelText("Split terminal down"));

    const tab = useUiStore.getState().terminals[2].tabs[0];
    expect(tab.panes).toHaveLength(2);
    expect(tab.direction).toBe("column");
  });

  it("split right adds a side-by-side pane (#316)", () => {
    seedTerminal();
    render(<TerminalHeader />);

    fireEvent.click(screen.getByLabelText("Split terminal right"));

    const tab = useUiStore.getState().terminals[2].tabs[0];
    expect(tab.panes).toHaveLength(2);
    expect(tab.direction).toBe("row");
  });

  it("disables the other-direction split once a tab is split (#316)", () => {
    seedTerminal();
    render(<TerminalHeader />);

    fireEvent.click(screen.getByLabelText("Split terminal right"));

    // The tab is now a row split — split-down is off, split-right still on.
    expect((screen.getByLabelText("Split terminal down") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Split terminal right") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("breadcrumb click opens the workspace with the session's repo", () => {
    seedTerminal();
    render(<TerminalHeader />);

    fireEvent.click(screen.getByTitle("Open Tools in the repo workspace"));
    const s = useUiStore.getState();
    expect(s.terminalOpen).toBe(false);
    expect(s.activeRepoId).toBe(1);
    expect(s.activeGroupId).toBe(2);
    expect(mocks.touchRepo).toHaveBeenCalledWith(1);
  });

  it("switches to a group that contains the repo when it left the session's group", () => {
    // The session's cwd repo now belongs only to group 3 — opening the
    // workspace must not leave group 2 active (the reconciler would swap in
    // a different repo there).
    mocks.groups = [group(1, "Default"), group(2, "Tools"), group(3, "Other")];
    mocks.repos = [repo(1, "alpha", { group_ids: [3] })];
    seedTerminal();
    render(<TerminalHeader />);

    fireEvent.click(screen.getByText("Open repo workspace"));
    const s = useUiStore.getState();
    expect(s.activeGroupId).toBe(3);
    expect(s.activeRepoId).toBe(1);
    expect(s.terminalOpen).toBe(false);
  });

  it("renames the session via the breadcrumb name (Enter commits)", () => {
    seedTerminal();
    render(<TerminalHeader />);

    fireEvent.click(screen.getByText("alpha shell"));
    const input = screen.getByLabelText("Rename terminal");
    fireEvent.change(input, { target: { value: "crawler" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useUiStore.getState().terminals[2].tabs[0].customTitle).toBe("crawler");
    expect(screen.getByText("crawler")).toBeTruthy();
  });

  it("Escape cancels a rename without committing", () => {
    seedTerminal();
    render(<TerminalHeader />);

    fireEvent.click(screen.getByText("alpha shell"));
    const input = screen.getByLabelText("Rename terminal");
    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(useUiStore.getState().terminals[2].tabs[0].customTitle).toBeUndefined();
    expect(screen.getByText("alpha shell")).toBeTruthy();
  });

  it("committing an empty draft reverts to the default title", () => {
    seedTerminal();
    useUiStore.getState().renameTerminalTab(2, "tab-1", "custom");
    render(<TerminalHeader />);

    fireEvent.click(screen.getByText("custom"));
    const input = screen.getByLabelText("Rename terminal");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useUiStore.getState().terminals[2].tabs[0].customTitle).toBeUndefined();
    expect(screen.getByText("alpha shell")).toBeTruthy();
  });
});
