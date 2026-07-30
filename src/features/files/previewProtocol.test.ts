import { beforeEach, describe, expect, it, vi } from "vitest";

// A9: the platform branch must reuse the existing `isWindows()` from
// `@/lib/shortcuts` rather than introducing a second platform detector — mocking
// exactly that export, and seeing the URL flip, is what proves the reuse.
vi.mock("@/lib/shortcuts", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/shortcuts")>()),
  isWindows: vi.fn(() => false),
}));

// The Rust half of the bridge, read as text so the two languages can be compared
// (see the drift-guard suite at the bottom). `?raw` keeps this free of node
// typings, the same trick the CSP suite uses to read `tauri.conf.json`.
import previewRs from "../../../src-tauri/src/preview.rs?raw";
import { isWindows } from "@/lib/shortcuts";
import {
  MSG_HTML,
  MSG_OPEN_EXTERNAL,
  MSG_READY,
  PREVIEW_SCHEME,
  previewUrl,
} from "./previewProtocol";

describe("previewUrl (#296)", () => {
  beforeEach(() => {
    vi.mocked(isWindows).mockReturnValue(false);
  });

  it("uses the http://<scheme>.localhost form on Windows", () => {
    vi.mocked(isWindows).mockReturnValue(true);
    expect(previewUrl()).toBe("http://gamut-preview.localhost/");
  });

  it("uses the <scheme>://localhost form everywhere else", () => {
    expect(previewUrl()).toBe("gamut-preview://localhost/");
  });

  it("never resolves to a local scheme (srcdoc/blob/data would inherit the app CSP)", () => {
    for (const windows of [true, false]) {
      vi.mocked(isWindows).mockReturnValue(windows);
      const url = previewUrl();
      expect(url).toContain(PREVIEW_SCHEME);
      expect(url.startsWith("blob:")).toBe(false);
      expect(url.startsWith("data:")).toBe(false);
      expect(url.startsWith("about:")).toBe(false);
    }
  });
});

// The two halves of this bridge are written in different languages, so nothing
// the compiler does can keep them in step: `preview.rs` defines the scheme and
// the message vocabulary for the frame, this module defines them for the parent,
// and a rename on one side alone breaks the handshake in silence — the frame
// would simply never be handed a buffer and the pane would sit blank.
//
// So read the Rust source and assert the values actually agree. Pinning the
// TypeScript literals against themselves (which is what this test used to do)
// proves nothing: it stays green through exactly the drift it claims to catch.
describe("preview message vocabulary (#296)", () => {
  const RUST_CONST = /pub const (\w+): &str = "([^"]+)";/g;
  const rust = new Map([...previewRs.matchAll(RUST_CONST)].map(([, name, value]) => [name, value]));

  it("reads the Rust constants (guards the regex above, not the app)", () => {
    expect([...rust.keys()]).toEqual(
      expect.arrayContaining(["SCHEME", "MSG_READY", "MSG_HTML", "MSG_OPEN_EXTERNAL"]),
    );
  });

  it.each([
    ["SCHEME", PREVIEW_SCHEME],
    ["MSG_READY", MSG_READY],
    ["MSG_HTML", MSG_HTML],
    ["MSG_OPEN_EXTERNAL", MSG_OPEN_EXTERNAL],
  ])("%s agrees with the TypeScript side", (rustName, tsValue) => {
    expect(rust.get(rustName)).toBe(tsValue);
  });

  it("the served bootstrap really carries the message types", () => {
    // Belt and braces: the constants could agree while the template that gets
    // substituted no longer references them.
    for (const type of [MSG_READY, MSG_HTML, MSG_OPEN_EXTERNAL]) {
      expect(previewRs).toContain(`__${nameOf(type)}__`);
    }
    function nameOf(value: string) {
      return [...rust.entries()].find(([, v]) => v === value)?.[0] ?? "UNKNOWN";
    }
  });
});
