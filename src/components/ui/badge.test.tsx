import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "@/components/ui/badge";

describe("Badge", () => {
  it("renders its children", () => {
    render(<Badge>3 changes</Badge>);
    expect(screen.getByText("3 changes")).toBeInTheDocument();
  });

  it("merges custom class names with the base styles", () => {
    render(<Badge className="text-red-500">danger</Badge>);
    const badge = screen.getByText("danger");
    expect(badge).toHaveClass("text-red-500");
    expect(badge).toHaveClass("rounded-full");
  });

  it("forwards arbitrary span attributes", () => {
    render(<Badge title="tooltip">hi</Badge>);
    expect(screen.getByText("hi")).toHaveAttribute("title", "tooltip");
  });
});
