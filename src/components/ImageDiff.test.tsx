import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import type { FileDiff } from "@/lib/ipc";
import { ImageDiff } from "./ImageDiff";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function diff(over: Partial<FileDiff>): FileDiff {
  return {
    path: "assets/logo.png",
    old_text: null,
    new_text: null,
    is_binary: true,
    old_image: null,
    new_image: null,
    ...over,
  };
}

describe("ImageDiff", () => {
  it("renders both sides for a modified image", () => {
    render(
      <ImageDiff
        diff={diff({ old_text: "", new_text: "", old_image: PNG, new_image: PNG })}
        oldLabel="main"
        newLabel="feature"
      />,
    );
    const imgs = screen.getAllByRole("img");
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toHaveAttribute("src", PNG);
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("feature")).toBeInTheDocument();
  });

  it("renders only the new side for an added image", () => {
    render(<ImageDiff diff={diff({ new_text: "", new_image: PNG })} />);
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByText("After (added)")).toBeInTheDocument();
    expect(screen.queryByText(/Before/)).not.toBeInTheDocument();
  });

  it("renders only the old side for a deleted image", () => {
    render(<ImageDiff diff={diff({ old_text: "", old_image: PNG })} />);
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByText("Before (deleted)")).toBeInTheDocument();
  });

  it("shows a notice for a side that exists but has no preview", () => {
    render(<ImageDiff diff={diff({ old_text: "", new_text: "", old_image: PNG })} />);
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByText(/No preview available/)).toBeInTheDocument();
  });
});
