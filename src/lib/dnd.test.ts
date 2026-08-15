import { afterEach, describe, expect, it, vi } from "vitest";

import { getActiveDrag, startDrag, subscribeDrag, subscribeDrop, type DragItem } from "./dnd";

// Dispatch an event the pointer-drag manager listens for. A MouseEvent carries
// clientX/clientY and fires for a "pointer*" listener, which is all the manager
// reads — no PointerEvent constructor needed under jsdom.
function firePointer(type: string, x: number, y: number) {
  window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
}

const REPO: DragItem = { kind: "repo", id: 1 };

afterEach(() => {
  // Make sure a half-finished drag from one test can't leak into the next.
  firePointer("pointercancel", 0, 0);
  firePointer("pointerup", 0, 0);
});

describe("pointer drag session", () => {
  it("does not start a drag until the pointer clears the threshold", () => {
    const moves = vi.fn();
    const off = subscribeDrag(moves);

    startDrag(REPO, "one", { clientX: 100, clientY: 100 });
    // A tiny jitter under the threshold must not begin a drag or select-suppress.
    firePointer("pointermove", 101, 101);
    expect(getActiveDrag()).toBeNull();
    expect(moves).not.toHaveBeenCalled();

    off();
    firePointer("pointerup", 101, 101);
  });

  it("activates past the threshold, tracks position, and fires onActivate once", () => {
    const onActivate = vi.fn();
    startDrag(REPO, "one", { clientX: 0, clientY: 0 }, onActivate);

    firePointer("pointermove", 50, 20);
    const active = getActiveDrag();
    expect(active).toMatchObject({ item: REPO, label: "one", x: 50, y: 20 });
    expect(onActivate).toHaveBeenCalledTimes(1);

    firePointer("pointermove", 60, 25);
    expect(getActiveDrag()).toMatchObject({ x: 60, y: 25 });
    expect(onActivate).toHaveBeenCalledTimes(1);

    firePointer("pointerup", 60, 25);
    expect(getActiveDrag()).toBeNull();
  });

  it("notifies drop subscribers with the released item and position", () => {
    const drop = vi.fn();
    const off = subscribeDrop(drop);

    startDrag(REPO, "one", { clientX: 0, clientY: 0 });
    firePointer("pointermove", 40, 40);
    firePointer("pointerup", 42, 44);

    expect(drop).toHaveBeenCalledTimes(1);
    expect(drop).toHaveBeenCalledWith(REPO, 42, 44);
    off();
  });

  it("does not fire a drop when the gesture never became a drag", () => {
    const drop = vi.fn();
    const off = subscribeDrop(drop);

    startDrag(REPO, "one", { clientX: 0, clientY: 0 });
    firePointer("pointerup", 1, 1); // released without crossing the threshold
    expect(drop).not.toHaveBeenCalled();
    off();
  });

  it("clears the active drag on pointercancel without a drop", () => {
    const drop = vi.fn();
    const off = subscribeDrop(drop);

    startDrag(REPO, "one", { clientX: 0, clientY: 0 });
    firePointer("pointermove", 30, 30);
    expect(getActiveDrag()).not.toBeNull();

    firePointer("pointercancel", 30, 30);
    expect(getActiveDrag()).toBeNull();
    expect(drop).not.toHaveBeenCalled();
    off();
  });
});
