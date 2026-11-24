import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { ContextMenu, ContextMenuItem } from "./context-menu";

const W = 200;
const H = 300;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(W);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(H);
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("innerHeight", 800);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderAt(x: number, y: number) {
  return render(
    <ContextMenu at={{ x, y }} onClose={() => {}}>
      <ContextMenuItem onClick={() => {}}>Item</ContextMenuItem>
    </ContextMenu>,
  );
}

describe("ContextMenu", () => {
  it("opens at the cursor when it fits, and is visible", () => {
    renderAt(100, 100);
    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe("100px");
    expect(menu.style.top).toBe("100px");
    expect(menu.style.visibility).toBe("");
  });

  it("opens above and left of the cursor near the bottom-right corner", () => {
    renderAt(900, 700);
    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe(`${900 - W}px`);
    expect(menu.style.top).toBe(`${700 - H}px`);
  });

  it("caps its height to the window so a tall menu scrolls", () => {
    renderAt(100, 100);
    const menu = screen.getByRole("menu");
    expect(menu.style.maxHeight).toBe("calc(100vh - 8px)");
    expect(menu.className).toContain("overflow-y-auto");
  });

  it("renders nothing when closed", () => {
    render(
      <ContextMenu at={null} onClose={() => {}}>
        <ContextMenuItem onClick={() => {}}>Item</ContextMenuItem>
      </ContextMenu>,
    );
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
