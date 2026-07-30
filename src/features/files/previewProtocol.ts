import { isWindows } from "@/lib/shortcuts";

/**
 * Wire protocol for the HTML preview (#296) — the parent half of the contract
 * the bootstrap document in `src-tauri/src/preview.rs` implements. Both sides
 * name the same constants so a rename can't silently break the handshake.
 */

/** Custom URI scheme the preview document is served from (see `preview.rs`). */
export const PREVIEW_SCHEME = "gamut-preview";

/** Frame → parent: the bootstrap's listener is live; here is its load token. */
export const MSG_READY = "gamut-preview-ready";
/** Parent → frame: render this buffer. */
export const MSG_HTML = "gamut-preview-html";
/** Frame → parent: the previewed page wants this `http(s)` URL opened outside. */
export const MSG_OPEN_EXTERNAL = "gamut-preview-open-external";

/**
 * URL of the preview origin.
 *
 * Windows' WebView2 addresses a registered custom scheme as
 * `http://<scheme>.localhost`; macOS' WKWebView and Linux' WebKitGTK both use the
 * `<scheme>://` form. Same platform switch Tauri's own `convertFileSrc` makes, and
 * it reuses `isWindows()` rather than sniffing the platform a second way. The app's
 * `frame-src` admits both forms, so a mis-branch shows an empty pane rather than
 * quietly loading something unexpected.
 */
export function previewUrl(): string {
  return isWindows() ? `http://${PREVIEW_SCHEME}.localhost/` : `${PREVIEW_SCHEME}://localhost/`;
}
