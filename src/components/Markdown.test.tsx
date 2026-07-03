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
// paragraph, so we peel it off and render it as a small key/value table.
describe("Markdown frontmatter", () => {
  it("renders a leading frontmatter block as a key/value table, not an <hr>", () => {
    const src = `---\nname: gamut:implement\ndescription: "Autonomous issue to PR"\nuser-invocable: true\n---\n\n# Heading\n\nBody text.`;
    const { container } = render(<Markdown>{src}</Markdown>);
    // No thematic break from the frontmatter fences.
    expect(container.querySelector("hr")).toBeNull();
    // Frontmatter rendered as a table with one row per key.
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(3);
    expect(rows[0].querySelectorAll("td")[0].textContent).toBe("name");
    expect(rows[0].querySelectorAll("td")[1].textContent).toBe("gamut:implement");
    // Surrounding quotes are stripped from the value.
    expect(rows[1].querySelectorAll("td")[1].textContent).toBe("Autonomous issue to PR");
    // Body still renders as markdown.
    expect(container.querySelector("h1")?.textContent).toBe("Heading");
  });

  it("folds indented continuation lines into the preceding value", () => {
    const src = `---\ndescription: >\n  first line\n  second line\n---\n\nbody`;
    const { container } = render(<Markdown>{src}</Markdown>);
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll("td")[1].textContent).toBe("> first line second line");
  });

  it("falls back to plain text when frontmatter is not simple key/value", () => {
    const src = `---\n- just\n- a list\n---\n\nbody`;
    const { container } = render(<Markdown>{src}</Markdown>);
    expect(container.querySelector("hr")).toBeNull();
    expect(container.querySelector("tbody")).toBeNull();
    expect(container.textContent).toContain("- just");
  });

  it("skips an empty frontmatter block without rendering an empty styled block", () => {
    const { container } = render(<Markdown>{`---\n\n---\n\nbody`}</Markdown>);
    expect(container.querySelector("hr")).toBeNull();
    expect(container.querySelector("tbody")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe("body");
  });

  it("leaves a mid-document thematic break alone", () => {
    const { container } = render(<Markdown>{`before\n\n---\n\nafter`}</Markdown>);
    expect(container.querySelector("hr")).not.toBeNull();
  });
});
