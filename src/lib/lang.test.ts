import { describe, it, expect } from "vitest";
import { isHtmlPath, languageFor } from "@/lib/lang";

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

  // A4 (#296): `.htm` had no entry at all before, so it fell through to
  // `plaintext` and opened with no highlighting.
  it("maps .htm to html like .html, case-insensitively (#296)", () => {
    expect(languageFor("a.htm")).toBe("html");
    expect(languageFor("a.html")).toBe("html");
    expect(languageFor("docs/nested/page.htm")).toBe("html");
    expect(languageFor("A.HTM")).toBe("html");
    expect(languageFor("A.HTML")).toBe("html");
    expect(languageFor("Index.Html")).toBe("html");
  });

  // A3/A4 (#296): `.vue` keeps mapping to html for *highlighting* — which is
  // precisely why the preview gate can't be `languageFor(path) === "html"`.
  it("still maps .vue to html for highlighting only (#296)", () => {
    expect(languageFor("src/App.vue")).toBe("html");
  });
});

// A5 (#296): the HTML preview gate is this single predicate, colocated with the
// LANG table so its `.vue` exclusion can't drift from a second matcher.
describe("isHtmlPath (#296)", () => {
  it("accepts .html and .htm at any case, at any depth", () => {
    for (const path of [
      "a.html",
      "a.htm",
      "A.HTML",
      "A.HTM",
      "Index.Html",
      "docs/deep/page.html",
      "windows\\style\\path.htm",
    ]) {
      expect(isHtmlPath(path)).toBe(true);
    }
  });

  // A3: highlighted as html, but not a renderable document — no preview toggle.
  it("rejects .vue, which only highlights as html", () => {
    expect(isHtmlPath("src/App.vue")).toBe(false);
  });

  it("rejects other extensions, extensionless files and near-misses", () => {
    for (const path of [
      "readme.md",
      "src/a.ts",
      "Dockerfile",
      "LICENSE",
      "",
      "html",
      ".html", // a dotfile *named* ".html" — a leading dot isn't an extension
      "a.html.bak",
      "a.xhtml",
      "a.htmlx",
    ]) {
      expect(isHtmlPath(path)).toBe(false);
    }
  });
});
