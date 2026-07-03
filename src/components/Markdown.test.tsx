import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "@/components/Markdown";

// rehype-raw lets raw HTML through, so PR bodies (remote, attacker-controllable
// GitHub content) must be sanitized before reaching the webview (#137).
describe("Markdown sanitization", () => {
  it("strips <script> tags from raw HTML", () => {
    const { container } = render(<Markdown>{`hi<script>window.pwned = 1</script>there`}</Markdown>);
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("window.pwned");
  });

  it("strips inline event handlers like onerror", () => {
    const { container } = render(<Markdown>{`<img src="x" onerror="window.pwned = 1">`}</Markdown>);
    expect(container.innerHTML).not.toContain("onerror");
    expect(container.innerHTML).not.toContain("window.pwned");
  });

  it("drops javascript: link protocols", () => {
    const { container } = render(<Markdown>{`[click](javascript:window.pwned=1)`}</Markdown>);
    expect(container.innerHTML.toLowerCase()).not.toContain("javascript:");
  });

  it("preserves checked task-list checkboxes", () => {
    const { container } = render(<Markdown>{`- [x] done\n- [ ] todo`}</Markdown>);
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
  });
});

// Skill/agent files start with a YAML frontmatter block fenced by `---`. Without
// special handling react-markdown renders it as an <hr> plus a mashed-together
// paragraph, so we peel it off and render it as its own plain-text block.
describe("Markdown frontmatter", () => {
  it("renders a leading frontmatter block as plain text, not an <hr>", () => {
    const src = `---\nname: gamut:implement\nuser-invocable: true\n---\n\n# Heading\n\nBody text.`;
    const { container } = render(<Markdown>{src}</Markdown>);
    // No thematic break from the frontmatter fences.
    expect(container.querySelector("hr")).toBeNull();
    // Raw key/value lines preserved verbatim in a single block.
    expect(container.textContent).toContain("name: gamut:implement");
    expect(container.textContent).toContain("user-invocable: true");
    // Body still renders as markdown.
    expect(container.querySelector("h1")?.textContent).toBe("Heading");
  });

  it("leaves a mid-document thematic break alone", () => {
    const { container } = render(<Markdown>{`before\n\n---\n\nafter`}</Markdown>);
    expect(container.querySelector("hr")).not.toBeNull();
  });
});
