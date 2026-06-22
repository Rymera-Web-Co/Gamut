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

  it("maps the JS/TS extension siblings (issue #122)", () => {
    expect(languageFor("server.cjs")).toBe("javascript");
    expect(languageFor("config.mts")).toBe("typescript");
    expect(languageFor("config.cts")).toBe("typescript");
  });

  it("treats jsonc/json5 as json", () => {
    expect(languageFor("tsconfig.jsonc")).toBe("json");
    expect(languageFor(".babelrc.json5")).toBe("json");
  });

  it("identifies extensionless files by basename", () => {
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("path/to/Dockerfile")).toBe("dockerfile");
    expect(languageFor("Makefile")).toBe("shell");
    expect(languageFor("Gemfile")).toBe("ruby");
  });

  it("identifies dotfile configs by basename", () => {
    expect(languageFor(".eslintrc")).toBe("json");
    expect(languageFor(".prettierrc")).toBe("json");
    expect(languageFor(".npmrc")).toBe("ini");
    expect(languageFor(".env")).toBe("shell");
    expect(languageFor(".env.local")).toBe("shell");
  });

  it("still resolves dotfiles that carry a real extension by that extension", () => {
    expect(languageFor(".eslintrc.json")).toBe("json");
    expect(languageFor(".eslintrc.yml")).toBe("yaml");
  });
});
