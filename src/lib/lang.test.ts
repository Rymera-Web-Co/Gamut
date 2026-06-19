import { describe, it, expect } from "vitest";
import { languageFor } from "@/lib/lang";

describe("languageFor", () => {
  it("maps common extensions to Monaco language ids", () => {
    expect(languageFor("src/main.tsx")).toBe("typescript");
    expect(languageFor("lib.rs")).toBe("rust");
    expect(languageFor("styles/app.scss")).toBe("scss");
    expect(languageFor("Cargo.toml")).toBe("ini");
  });

  it("is case-insensitive on the extension", () => {
    expect(languageFor("README.MD")).toBe("markdown");
    expect(languageFor("Component.TSX")).toBe("typescript");
  });

  it("falls back to plaintext for unknown or missing extensions", () => {
    expect(languageFor("LICENSE")).toBe("plaintext");
    expect(languageFor("data.unknownext")).toBe("plaintext");
  });
});
