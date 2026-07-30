import { describe, expect, it } from "vitest";

// The shipped Tauri config, read as data. Importing it (rather than reading the
// file) keeps this suite free of node typings and still fails if the real file
// changes, which is the whole point.
import tauriConf from "../../src-tauri/tauri.conf.json";

/**
 * Guards the *negative* half of the app's Content-Security-Policy — the parts
 * whose entire value is what they refuse, and which are one careless edit away
 * from silently disappearing:
 *
 * - `frame-src` exists only for the HTML preview's own origin (#296). Widening it
 *   (`'self'`, a wildcard, a remote host) gives the sandboxed preview frame —
 *   which runs untrusted page scripts on a deliberately CSP-free origin —
 *   somewhere else to navigate *itself* to, including back into the app origin.
 * - `script-src 'self'` with no `'unsafe-inline'`/`'unsafe-eval'` is what stops
 *   injected markup in the app window from executing. `devCsp` deliberately allows
 *   both for Vite's HMR, so those assertions are on the shipped `csp` only — that
 *   dev/prod asymmetry is exactly why the preview can't be fed with `srcdoc`.
 *
 * A failure here means the app's CSP loosened. It is not a formatting nit.
 */

/** The only `frame-src` the app may ship: the preview scheme, in its `<scheme>:`
 * form and the `http://<scheme>.localhost` form Windows/Linux address it by.
 * Mirrors `SCHEME` in `src-tauri/src/preview.rs`. */
const PREVIEW_FRAME_SRC = "gamut-preview: http://gamut-preview.localhost";

const security = tauriConf.app.security;

/** Split a CSP into `directive → source list`, with whitespace normalised. */
function directives(csp: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of csp.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    map.set(tokens[0], tokens.slice(1).join(" "));
  }
  return map;
}

describe("the app's Content-Security-Policy has not loosened", () => {
  for (const [name, csp] of [
    ["csp", security.csp],
    ["devCsp", security.devCsp],
  ] as const) {
    it(`${name}: frame-src still admits only the HTML preview origin`, () => {
      expect(directives(csp).get("frame-src")).toBe(PREVIEW_FRAME_SRC);
    });
  }

  it("csp: script-src is 'self' only — no 'unsafe-inline', no 'unsafe-eval'", () => {
    const scriptSrc = directives(security.csp).get("script-src");
    expect(scriptSrc).toBeDefined();
    const sources = new Set((scriptSrc ?? "").split(/\s+/).filter(Boolean));
    expect(sources.has("'self'")).toBe(true);
    expect(sources.has("'unsafe-inline'")).toBe(false);
    expect(sources.has("'unsafe-eval'")).toBe(false);
  });
});
