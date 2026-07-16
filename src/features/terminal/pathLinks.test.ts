import { describe, expect, it } from "vitest";
import { matchPaths, stripLineSuffix, urlRangesIn } from "./pathLinks";

/** Just the matched path texts, for terse assertions. */
function paths(text: string): string[] {
  return matchPaths(text, urlRangesIn(text)).map((m) => m.text);
}

describe("matchPaths", () => {
  it("detects rooted paths (absolute, ~, ./, ../)", () => {
    expect(paths("error at /Users/junix/foo.ts here")).toEqual(["/Users/junix/foo.ts"]);
    expect(paths("open /etc/hosts")).toEqual(["/etc/hosts"]);
    expect(paths("edit ~/.bashrc now")).toEqual(["~/.bashrc"]);
    expect(paths("see ./src/foo and ../lib/bar")).toEqual(["./src/foo", "../lib/bar"]);
  });

  it("detects cwd-relative paths only when they carry an extension", () => {
    expect(paths("failed src/foo.ts line")).toEqual(["src/foo.ts"]);
    expect(paths("at pkg/mod/file.rs:")).toEqual(["pkg/mod/file.rs"]);
    // No extension and no anchor → treated as prose, not a path.
    expect(paths("choose and/or either")).toEqual([]);
    expect(paths("dated 12/31/2024 today")).toEqual([]);
  });

  it("does not treat a bare number or word as a path", () => {
    expect(paths("pi is 3.14 exactly")).toEqual([]);
    expect(paths("README mentions e.g. this")).toEqual([]);
  });

  it("keeps a :line:col suffix in the match so it underlines", () => {
    expect(paths("src/foo.ts:42:10: TypeError")).toEqual(["src/foo.ts:42:10"]);
    expect(paths("/a/b.rs:7 warning")).toEqual(["/a/b.rs:7"]);
  });

  it("trims trailing sentence punctuation but not the extension", () => {
    expect(paths("check /etc/hosts.")).toEqual(["/etc/hosts"]);
    expect(paths("(see src/foo.ts)")).toEqual(["src/foo.ts"]);
    expect(paths("edit /tmp/a.js, then run")).toEqual(["/tmp/a.js"]);
  });

  it("skips the path portion of a URL", () => {
    // The `/repo/blob/main/src/foo.ts` inside the URL must not be a path hit.
    expect(paths("https://github.com/o/r/blob/main/src/foo.ts")).toEqual([]);
    // A real path following a URL is still detected.
    const line = "https://example.com/x see /tmp/out.log";
    expect(paths(line)).toEqual(["/tmp/out.log"]);
  });

  it("handles real-world tool output", () => {
    // rustc / vitest style `path:line:col`.
    expect(paths("  --> src/commands/files.rs:458:12")).toEqual(["src/commands/files.rs:458:12"]);
    expect(paths("FAIL src/features/terminal/pathLinks.test.ts:21:43")).toEqual([
      "src/features/terminal/pathLinks.test.ts:21:43",
    ]);
    // grep with a `:` that isn't a line number.
    expect(paths("grep: /etc/hosts: Permission denied")).toEqual(["/etc/hosts"]);
    // ripgrep / binary-file notices.
    expect(paths("Binary file /Users/x/logo.png matches")).toEqual(["/Users/x/logo.png"]);
    // dot-relative tool paths.
    expect(paths("running ./node_modules/.bin/vitest")).toEqual(["./node_modules/.bin/vitest"]);
  });

  it("reports correct offsets", () => {
    const line = "run src/foo.ts now";
    const [hit] = matchPaths(line, urlRangesIn(line));
    expect(hit.index).toBe(4);
    expect(line.slice(hit.index, hit.index + hit.text.length)).toBe("src/foo.ts");
  });
});

describe("stripLineSuffix", () => {
  it("splits a :line:col suffix off the path", () => {
    expect(stripLineSuffix("src/foo.ts:42:10")).toEqual({ path: "src/foo.ts", line: 42 });
    expect(stripLineSuffix("/a/b.rs:7")).toEqual({ path: "/a/b.rs", line: 7 });
  });

  it("leaves a plain path untouched", () => {
    expect(stripLineSuffix("src/foo.ts")).toEqual({ path: "src/foo.ts" });
    expect(stripLineSuffix("/etc/hosts")).toEqual({ path: "/etc/hosts" });
  });
});
