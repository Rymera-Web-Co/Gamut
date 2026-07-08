import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDraggable, useDropTarget } from "./usePointerDnd";

// jsdom gives every element a zero-sized rect, so the hit-testing in
// useDropTarget would never match. Assign each row a real rect by its id.
const RECTS: Record<number, DOMRect> = {
  1: rect(0, 0, 100, 20),
  2: rect(0, 20, 100, 40),
};

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

function Row({ id, onReorder }: { id: number; onReorder: (src: number, target: number) => void }) {
  const drag = useDraggable({ kind: "repo", id }, `repo-${id}`);
  const { ref, state } = useDropTarget<boolean, HTMLDivElement>({
    accepts: (d) => d.kind === "repo" && d.id !== id,
    compute: () => true,
    onDrop: (d) => {
      if (d.kind === "repo") onReorder(d.id, id);
    },
  });
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (el) el.getBoundingClientRect = () => RECTS[id];
      }}
      data-testid={`row-${id}`}
      {...drag}
    >
      row-{id}
      {state ? " over" : ""}
    </div>
  );
}

// The window-level pointermove/up the drag manager listens for. Wrapped in
// act() so the hover state updates it triggers are flushed before assertions.
function win(type: string, x: number, y: number) {
  act(() => {
    window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
  });
}

afterEach(() => {
  win("pointercancel", 0, 0);
});

// Two stacked rows sharing one reorder callback — the fixture both drag tests use.
function renderTwoRows(onReorder: (src: number, target: number) => void) {
  return render(
    <>
      <Row id={1} onReorder={onReorder} />
      <Row id={2} onReorder={onReorder} />
    </>,
  );
}

describe("useDraggable + useDropTarget", () => {
  it("reorders when a row is dragged onto another and released over it", () => {
    const onReorder = vi.fn();
    renderTwoRows(onReorder);

    fireEvent.pointerDown(screen.getByTestId("row-1"), { button: 0, clientX: 5, clientY: 10 });
    win("pointermove", 5, 25); // cross the threshold, now over row 2
    expect(screen.getByTestId("row-2")).toHaveTextContent("over");
    win("pointerup", 5, 25);

    expect(onReorder).toHaveBeenCalledWith(1, 2);
  });

  it("does not reorder when released away from any target", () => {
    const onReorder = vi.fn();
    renderTwoRows(onReorder);

    fireEvent.pointerDown(screen.getByTestId("row-1"), { button: 0, clientX: 5, clientY: 10 });
    win("pointermove", 5, 200); // dragged well below both rows
    win("pointerup", 5, 200);

    expect(onReorder).not.toHaveBeenCalled();
  });

  it("treats a press without movement as a click, not a drag", () => {
    const onReorder = vi.fn();
    render(<Row id={1} onReorder={onReorder} />);

    fireEvent.pointerDown(screen.getByTestId("row-1"), { button: 0, clientX: 5, clientY: 10 });
    win("pointerup", 5, 10); // released in place

    expect(onReorder).not.toHaveBeenCalled();
    expect(screen.getByTestId("row-1")).not.toHaveTextContent("over");
  });
});
