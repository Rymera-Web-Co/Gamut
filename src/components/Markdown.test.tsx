import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "@/components/Markdown";

// rehype-raw lets raw HTML through, so PR bodies (remote, attacker-controllable
// GitHub content) must be sanitized before reaching the webview (#137).
describe("Markdown sanitization", () => {
  it("strips <script> tags from raw HTML", () => {
    const { container } = render(
      <Markdown>{`hi<script>window.pwned = 1</script>there`}</Markdown>,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("window.pwned");
  });

  it("strips inline event handlers like onerror", () => {
    const { container } = render(
      <Markdown>{`<img src="x" onerror="window.pwned = 1">`}</Markdown>,
    );
    expect(container.innerHTML).not.toContain("onerror");
    expect(container.innerHTML).not.toContain("window.pwned");
  });

  it("drops javascript: link protocols", () => {
    const { container } = render(
      <Markdown>{`[click](javascript:window.pwned=1)`}</Markdown>,
    );
    expect(container.innerHTML.toLowerCase()).not.toContain("javascript:");
  });

  it("preserves checked task-list checkboxes", () => {
    const { container } = render(
      <Markdown>{`- [x] done\n- [ ] todo`}</Markdown>,
    );
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
  });
});
