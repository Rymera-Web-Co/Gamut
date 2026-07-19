import { describe, expect, it } from "vitest";

import { toIdeSelection } from "./useIdeSelectionSync";

/** A minimal stand-in for a Monaco selection. */
function sel(
  startLineNumber: number,
  startColumn: number,
  endLineNumber: number,
  endColumn: number,
) {
  const empty = startLineNumber === endLineNumber && startColumn === endColumn;
  return { startLineNumber, startColumn, endLineNumber, endColumn, isEmpty: () => empty };
}

describe("toIdeSelection", () => {
  it("converts Monaco 1-based coordinates to zero-based", () => {
    const out = toIdeSelection(sel(10, 5, 15, 20), "/abs/foo.ts", "hello");
    expect(out).toEqual({
      text: "hello",
      file_path: "/abs/foo.ts",
      start_line: 9,
      start_char: 4,
      end_line: 14,
      end_char: 19,
      is_empty: false,
    });
  });

  it("marks a collapsed caret as empty with matching start/end", () => {
    const out = toIdeSelection(sel(3, 1, 3, 1), "/abs/bar.ts", "");
    expect(out.is_empty).toBe(true);
    expect(out.start_line).toBe(2);
    expect(out.start_char).toBe(0);
    expect(out.end_line).toBe(2);
    expect(out.end_char).toBe(0);
  });

  it("keeps a non-empty single-line selection non-empty", () => {
    const out = toIdeSelection(sel(1, 1, 1, 12), "/abs/baz.ts", "let x = 1;");
    expect(out.is_empty).toBe(false);
    expect(out.start_line).toBe(0);
    expect(out.end_char).toBe(11);
  });
});
