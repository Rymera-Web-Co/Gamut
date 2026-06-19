import { describe, it, expect } from "vitest";
import { summarizePull } from "./summarizePull";

describe("summarizePull", () => {
  it("falls back to 'Pulled' for empty output", () => {
    expect(summarizePull("")).toBe("Pulled");
    expect(summarizePull("   \n  ")).toBe("Pulled");
  });

  it("recognises the 'already up to date' message regardless of punctuation", () => {
    expect(summarizePull("Already up to date.")).toBe("Already up to date.");
    expect(summarizePull("already up-to-date")).toBe("Already up to date.");
    expect(summarizePull("ALREADY UP TO DATE")).toBe("Already up to date.");
  });

  it("extracts the diffstat totals line", () => {
    const out = [
      "Updating a1b2c3d..e4f5g6h",
      "Fast-forward",
      " src/main.rs | 4 ++--",
      " 3 files changed, 12 insertions(+), 2 deletions(-)",
    ].join("\n");
    expect(summarizePull(out)).toBe("Pulled · 3 files changed, 12 insertions(+), 2 deletions(-)");
  });

  it("handles the singular 'file changed' form", () => {
    expect(summarizePull(" 1 file changed, 1 insertion(+)")).toBe(
      "Pulled · 1 file changed, 1 insertion(+)",
    );
  });

  it("falls back to 'Pulled' when no recognisable line is present", () => {
    expect(summarizePull("Some unexpected git output\nwith no totals")).toBe("Pulled");
  });
});
