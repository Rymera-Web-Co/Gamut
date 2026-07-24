import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// TopTabs derives its tab set from the active repo's git-ness, which reads the
// repo list via react-query — stub the api hook so no QueryClient is needed.
vi.mock("@/features/repos/api", () => ({
  useRepos: () => ({ data: [] }),
}));

import { TopTabs } from "./TopTabs";
import { useUiStore } from "@/store/ui";

/** All rendered <button> elements in document order. */
function buttons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button"));
}

function repoToggle(container: HTMLElement): HTMLButtonElement {
  return buttons(container).find((b) => /repositories/i.test(b.title))!;
}

function themeToggle(container: HTMLElement): HTMLButtonElement {
  return buttons(container).find((b) => /theme/i.test(b.title))!;
}

function firstViewTab(container: HTMLElement): HTMLButtonElement {
  return buttons(container).find((b) => b.textContent?.includes("Files"))!;
}

describe("TopTabs repositories toggle placement (#283)", () => {
  beforeEach(() => {
    useUiStore.setState({ view: "files", activeRepoId: null, repoSidebarHidden: true });
  });

  it("A1: renders the repositories toggle before the first view tab", () => {
    const { container } = render(<TopTabs />);
    const all = buttons(container);
    expect(all.indexOf(repoToggle(container))).toBeLessThan(all.indexOf(firstViewTab(container)));
  });

  it("A2: keeps the theme toggle to the right of the view tabs (rightmost control)", () => {
    const { container } = render(<TopTabs />);
    const all = buttons(container);
    const theme = themeToggle(container);
    expect(all.indexOf(theme)).toBeGreaterThan(all.indexOf(firstViewTab(container)));
    expect(all.indexOf(repoToggle(container))).toBeLessThan(all.indexOf(theme));
  });

  it("A3: clicking the toggle flips repoSidebarHidden", () => {
    const { container } = render(<TopTabs />);
    fireEvent.click(repoToggle(container));
    expect(useUiStore.getState().repoSidebarHidden).toBe(false);
    fireEvent.click(repoToggle(container));
    expect(useUiStore.getState().repoSidebarHidden).toBe(true);
  });

  it("A5: the right-click context-menu entry toggles the sidebar", () => {
    const { container } = render(<TopTabs />);
    fireEvent.contextMenu(container.firstElementChild!);
    const item = screen.getByText("Show repositories");
    fireEvent.click(item);
    expect(useUiStore.getState().repoSidebarHidden).toBe(false);
  });

  it("A6: shows PanelLeft when hidden and PanelLeftClose when shown", () => {
    useUiStore.setState({ repoSidebarHidden: true });
    const { container, rerender } = render(<TopTabs />);
    expect(repoToggle(container).querySelector("svg")).toHaveClass("lucide-panel-left");

    useUiStore.setState({ repoSidebarHidden: false });
    rerender(<TopTabs />);
    expect(repoToggle(container).querySelector("svg")).toHaveClass("lucide-panel-left-close");
  });
});
