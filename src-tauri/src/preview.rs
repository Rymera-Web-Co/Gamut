//! The HTML-preview origin (#296).
//!
//! The Files view previews an `.html`/`.htm` buffer inside a sandboxed iframe.
//! The frame can't be fed with `srcdoc` (or a `blob:`/`data:` URL): those are
//! *local* schemes, so the frame document inherits the app window's policy
//! container — the app's `script-src 'self'` would then apply inside the frame
//! and refuse the previewed page's own inline `<script>`. (It appears to work
//! under `tauri dev`, whose `devCsp` allows `'unsafe-inline'`, and silently
//! breaks in a shipped build.)
//!
//! A dedicated custom URI scheme is not a local scheme, so the frame gets its
//! own, empty policy container. That is why the response below deliberately
//! carries **no** `Content-Security-Policy` header: the previewed document must
//! be free to run its own scripts, and the sandbox attribute (`allow-scripts`
//! only, no `allow-same-origin`) is what contains it — an opaque origin with no
//! storage, no access to the parent document and no Tauri IPC.
//!
//! The served document is a constant bootstrap: it holds no user content, and
//! the previewed HTML only ever reaches it as a `postMessage` from its own
//! parent (validated by source identity plus a per-load token).

use std::sync::OnceLock;

use tauri::http::{Request, Response, StatusCode};

/// URI scheme the preview document is served from. Windows' WebView2 addresses a
/// registered custom scheme as `http://<scheme>.localhost`; macOS and Linux use
/// the `<scheme>://` form.
/// Mirrored by `PREVIEW_SCHEME` in `src/features/files/previewProtocol.ts`.
pub const SCHEME: &str = "gamut-preview";

/// Handshake the bootstrap posts up to its parent once its listener is live.
/// Mirrored by `MSG_READY` in `src/features/files/previewProtocol.ts`.
pub const MSG_READY: &str = "gamut-preview-ready";
/// Message the parent posts down with the buffer to render.
/// Mirrored by `MSG_HTML` in `src/features/files/previewProtocol.ts`.
pub const MSG_HTML: &str = "gamut-preview-html";
/// Message the injected link runtime posts up for an `http(s)` link, which the
/// parent validates and hands to `openUrl`.
/// Mirrored by `MSG_OPEN_EXTERNAL` in `src/features/files/previewProtocol.ts`.
pub const MSG_OPEN_EXTERNAL: &str = "gamut-preview-open-external";

/// Template for the bootstrap document. The `__MSG_*__` placeholders are
/// substituted from the constants above, so the message vocabulary has exactly
/// one definition per side of the bridge and cannot drift within Rust.
///
/// It renders the buffer with `document.open()/write()/close()` rather than
/// `innerHTML`: assigning `innerHTML` never executes inline `<script>` elements,
/// regardless of CSP, so it would silently drop the behaviour of every previewed
/// page. `document.write` into a freshly opened document parses and runs them.
///
/// The link runtime installed around each write keeps navigation inside the pane:
/// an in-page `#hash` link scrolls the frame, an `http(s)` link is handed up to
/// the app (which opens it in the real browser, the same path markdown links
/// take), and any other scheme is left untouched.
const TEMPLATE: &str = r##"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Gamut HTML preview</title>
    <style>
      /* Only ever seen before the previewed document is written: transparent so
         the themed pane behind the frame shows through instead of a white flash.
         `document.write` replaces this document wholesale, so once content lands
         the frame element's own background is what backs an unstyled page. */
      html,
      body {
        margin: 0;
        background: transparent;
      }
    </style>
  </head>
  <body>
    <script>
      (function () {
        var TYPE_READY = "__MSG_READY__";
        var TYPE_HTML = "__MSG_HTML__";
        var TYPE_OPEN_EXTERNAL = "__MSG_OPEN_EXTERNAL__";

        // Per-load token. The parent adopts it from the ready handshake and
        // requires it on everything we post afterwards, so a message from a
        // torn-down frame can never drive the app.
        //
        // There is deliberately **no** fallback if `crypto.getRandomValues` is
        // missing. The previewed page shares this realm, so every weaker source we
        // could reach for -- the realm's shared non-crypto PRNG, the clock -- is
        // one the page can reproduce, and a guessed token lets it post a valid
        // open-external message with no click at all. A security token must fail
        // closed, so we let this throw: the ready handshake below never runs and
        // the parent's ready timeout reports the failure. Each word is zero-padded
        // to 8 hex digits so the token has a fixed length and two different word
        // sequences can never collapse to the same string.
        function randomToken() {
          var words = new Uint32Array(4);
          window.crypto.getRandomValues(words);
          var out = "";
          for (var i = 0; i < words.length; i++) {
            out += ("0000000" + words[i].toString(16)).slice(-8);
          }
          return out;
        }

        var token = randomToken();

        function anchorFor(node) {
          while (node && node.nodeType === 1) {
            // Case-insensitively: an SVG `<a>` reports a lowercase `tagName`, and
            // it links just like an HTML one, so it must route through the runtime
            // below rather than navigating the frame.
            if (node.tagName && String(node.tagName).toLowerCase() === "a") return node;
            node = node.parentNode;
          }
          return null;
        }

        function wireLinks(doc) {
          doc.addEventListener(
            "click",
            function (e) {
              var link = anchorFor(e.target);
              if (!link) return;
              // Read the href *attribute*, never the property. An SVG `<a>` has no
              // URL-part accessors at all (no protocol/host, and its `href` is an
              // SVGAnimatedString rather than a resolved string), so the attribute
              // plus the single parse below is the only element-agnostic reading of
              // a link — and it is simpler than branching on three anchor
              // properties that only ever existed on the HTML element.
              var href = link.getAttribute("href");
              if (!href) return;
              // In-page anchor: scroll within the frame, leave location alone.
              // Tested on the raw attribute *before* parsing, which is both the
              // cheapest and the most faithful test for "this is an in-page
              // fragment".
              if (href.charAt(0) === "#") {
                e.preventDefault();
                var id = href.slice(1);
                if (!id) return;
                var target = doc.getElementById(id) || doc.getElementsByName(id)[0];
                if (target && target.scrollIntoView) {
                  target.scrollIntoView({ behavior: "smooth", block: "start" });
                }
                return;
              }
              // Every remaining decision is made on one resolved URL. `doc.baseURI`
              // is read per click, so a previewed page's own `<base>` is honoured.
              var u;
              try {
                u = new URL(href, doc.baseURI);
              } catch (err) {
                return;
              }
              // Anything that resolves back onto the preview origin is a dead end
              // — this scheme serves one document and 404s every other path — so
              // swallow it instead of blanking the pane. Two shapes arrive here:
              //   * a plain relative link (`href="other.html"`). On Windows the
              //     base is itself `http://gamut-preview.localhost`, so without
              //     this it would look like an external http link and open in the
              //     user's browser.
              //   * a protocol-relative `//host/path`, which off Windows resolves
              //     to `gamut-preview://host/path` — a *different* host, so the
              //     host comparison alone misses it. Every host on the custom
              //     scheme is a dead end, which is what the second clause covers.
              //     It is deliberately scoped to the custom-scheme form: on Windows
              //     this origin *is* `http:`, and swallowing every same-protocol
              //     link there would eat every genuine external link on the page.
              // `u.origin` is not usable here: a non-special scheme's origin is the
              // string "null", which is also this sandboxed frame's own
              // `location.origin`, so an origin comparison would additionally
              // swallow every *other* non-special scheme (`mailto:`, `tel:`, …)
              // that must be left untouched.
              var ownProtocol = u.protocol === location.protocol;
              var customScheme = location.protocol !== "http:" && location.protocol !== "https:";
              if (ownProtocol && (u.host === location.host || customScheme)) {
                e.preventDefault();
                return;
              }
              // External link (including target="_blank"): hand it to the app
              // rather than navigating the frame or opening a popup.
              if (u.protocol === "http:" || u.protocol === "https:") {
                e.preventDefault();
                // Only a real user click opens the user's browser. Without this a
                // previewed page could spray tabs by dispatching synthetic clicks
                // on links it creates itself — the token can't prevent that,
                // since the forged click goes through this very handler.
                if (!e.isTrusted) return;
                parent.postMessage({ type: TYPE_OPEN_EXTERNAL, token: token, url: u.href }, "*");
              }
            },
            true,
          );
        }

        function render(html) {
          // `document.open()` clears the document's event listeners, so the link
          // runtime has to be (re)installed on the *other* side of it. Installing
          // it before the write rather than after `close()` matters: a previewed
          // page's own script runs *during* parsing, so a page that clicks a link
          // as it loads would otherwise slip past the runtime entirely. The
          // listener is delegated to the document, so it still catches clicks on
          // elements the write hasn't produced yet.
          document.open();
          wireLinks(document);
          document.write(html);
          document.close();
        }

        window.addEventListener("message", function (e) {
          // The frame is sandboxed without allow-same-origin, so its own origin
          // is the opaque string "null" and e.origin is useless here — source
          // identity against window.parent is the only sound inbound check.
          if (e.source !== window.parent) return;
          var d = e.data;
          if (!d || typeof d !== "object") return;
          if (d.type !== TYPE_HTML) return;
          if (d.token !== token) return;
          render(typeof d.html === "string" ? d.html : "");
        });

        parent.postMessage({ type: TYPE_READY, token: token }, "*");
      })();
    </script>
  </body>
</html>
"##;

/// The constant bootstrap document served on the preview scheme.
pub fn preview_document() -> &'static str {
    static DOCUMENT: OnceLock<String> = OnceLock::new();
    DOCUMENT
        .get_or_init(|| {
            TEMPLATE
                .replace("__MSG_READY__", MSG_READY)
                .replace("__MSG_HTML__", MSG_HTML)
                .replace("__MSG_OPEN_EXTERNAL__", MSG_OPEN_EXTERNAL)
        })
        .as_str()
}

/// Serve the bootstrap at the root of the preview scheme, and a 404 elsewhere.
///
/// Uncacheable so a bootstrap change ships with the app rather than surviving in
/// the webview's cache, and with no `Content-Security-Policy` header — see the
/// module docs for why that is the point rather than an omission.
pub fn handle_request(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    // The bootstrap lives at the root and nowhere else. Without this, a previewed
    // page's relative sub-resource (`<img src="logo.png">`, a stylesheet, a
    // `<script src>`) would be answered with the bootstrap's own HTML under a 200,
    // which renders as a broken image, a rejected stylesheet, or a script that
    // throws a parse error. A 404 is both honest and what a browser would give:
    // the preview renders a single self-contained document, and relative assets on
    // disk are deliberately not served (that would mean handing this origin a
    // window onto the filesystem).
    if request.uri().path() != "/" {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("Content-Type", "text/plain; charset=utf-8")
            .header("Cache-Control", "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .body(Vec::new())
            .expect("the constant 404 response is always a valid http::Response");
    }
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Cache-Control", "no-store")
        // The body is a fixed HTML document; never let a sniffer decide otherwise.
        .header("X-Content-Type-Options", "nosniff")
        .body(preview_document().as_bytes().to_vec())
        // The body and headers are constants, so this can only fail if they stop
        // being valid HTTP — which a test below pins.
        .expect("the constant preview response is always a valid http::Response")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response() -> Response<Vec<u8>> {
        let request = Request::builder()
            .uri("gamut-preview://localhost/")
            .body(Vec::new())
            .unwrap();
        handle_request(&request)
    }

    #[test]
    fn serves_the_bootstrap_as_utf8_html() {
        let res = response();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get("Content-Type").unwrap(),
            "text/html; charset=utf-8"
        );
        assert_eq!(res.body(), preview_document().as_bytes());
    }

    fn response_for(uri: &str) -> Response<Vec<u8>> {
        let request = Request::builder().uri(uri).body(Vec::new()).unwrap();
        handle_request(&request)
    }

    /// A previewed page's relative sub-resources must 404 rather than be answered
    /// with the bootstrap's own HTML under a 200 — that lands in an `<img>` or a
    /// `<script src>` as a broken asset or a parse error. The preview renders one
    /// self-contained document; nothing else is served on this origin.
    #[test]
    fn serves_nothing_but_the_bootstrap_at_the_root() {
        for path in ["/logo.png", "/style.css", "/app.js", "/index.html", "/a/b"] {
            let res = response_for(&format!("gamut-preview://localhost{path}"));
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{path} should 404");
            assert!(res.body().is_empty(), "{path} should have an empty body");
        }
        // The Windows form of the same origin resolves identically.
        assert_eq!(
            response_for("http://gamut-preview.localhost/").status(),
            StatusCode::OK
        );
        assert_eq!(
            response_for("http://gamut-preview.localhost/logo.png").status(),
            StatusCode::NOT_FOUND
        );
    }

    /// The body is a fixed HTML document, so never let a sniffer reinterpret it.
    #[test]
    fn refuses_content_type_sniffing() {
        assert_eq!(
            response().headers().get("X-Content-Type-Options").unwrap(),
            "nosniff"
        );
        assert_eq!(
            response_for("gamut-preview://localhost/x")
                .headers()
                .get("X-Content-Type-Options")
                .unwrap(),
            "nosniff"
        );
    }

    #[test]
    fn is_not_cached() {
        assert_eq!(
            response().headers().get("Cache-Control").unwrap(),
            "no-store"
        );
    }

    /// A19: the empty policy container is the whole reason for the custom scheme,
    /// so a CSP header here would silently disable every previewed page's own
    /// scripts. `HeaderMap` lookups are case-insensitive.
    #[test]
    fn carries_no_content_security_policy_header() {
        let res = response();
        assert!(res.headers().get("Content-Security-Policy").is_none());
        assert!(res
            .headers()
            .get("Content-Security-Policy-Report-Only")
            .is_none());
    }

    /// Drift guard only (the behaviour itself is verified by a real-engine probe,
    /// per the contract): the document must speak the same message vocabulary as
    /// the TypeScript parent, with every placeholder substituted.
    #[test]
    fn document_speaks_the_shared_message_vocabulary() {
        let doc = preview_document();
        for ty in [MSG_READY, MSG_HTML, MSG_OPEN_EXTERNAL] {
            assert!(doc.contains(ty), "bootstrap is missing {ty}");
        }
        assert!(
            !doc.contains("__MSG_"),
            "an unsubstituted placeholder shipped"
        );
    }

    /// Drift guard only: `innerHTML` would never execute a previewed page's
    /// inline `<script>`, CSP or not, so the injection path must stay
    /// `document.open()/write()/close()`.
    #[test]
    fn document_injects_via_document_write_not_inner_html() {
        let doc = preview_document();
        assert!(doc.contains("document.open()"));
        assert!(doc.contains("document.write("));
        assert!(doc.contains("document.close()"));
        assert!(!doc.contains("innerHTML"));
    }

    /// Drift guard only: the inbound check must stay source-identity based —
    /// `e.origin` is the opaque string "null" for this sandbox, so an origin
    /// comparison here would be either useless or a lock-out.
    #[test]
    fn document_validates_inbound_messages_by_source_identity() {
        assert!(preview_document().contains("e.source !== window.parent"));
    }

    /// Drift guard only — the routing behaviour itself is verified by a real-engine
    /// probe, per the contract. Three link-runtime guards that are easy to drop and
    /// whose absence is invisible on macOS:
    /// - the dead-end bail-out for anything resolving back onto the preview origin,
    ///   without which a *relative* link on Windows (where this origin is
    ///   `http://gamut-preview.localhost`) is mistaken for an external link and
    ///   opened in the user's browser, and a protocol-relative `//host/path` off
    ///   Windows navigates the frame to a 404 and blanks the pane;
    /// - the trusted-click gate, without which a previewed page can open browser
    ///   tabs on its own by dispatching synthetic clicks;
    /// - posting the *resolved* URL, so the app opens the link the click meant.
    #[test]
    fn document_guards_the_external_link_bridge() {
        let doc = preview_document();
        assert!(doc.contains("u.protocol === location.protocol"));
        assert!(doc.contains("u.host === location.host"));
        assert!(doc.contains(r#"location.protocol !== "http:" && location.protocol !== "https:""#));
        assert!(doc.contains("!e.isTrusted"));
        assert!(doc.contains("url: u.href"));
    }

    /// Drift guard only (an SVG anchor can only really be clicked in a browser, so
    /// the routing is covered by the real-engine probe): the link runtime must work
    /// for an SVG `<a>` as well as an HTML one. That needs *two* things, and having
    /// only the first is the trap — the anchor gets found and then falls through
    /// every branch, so an external SVG link silently does nothing:
    /// - a case-insensitive `tagName` match, since an SVG `<a>` reports `"a"`;
    /// - every URL decision taken on a URL resolved from the href *attribute*.
    ///   `SVGAElement` implements none of `HTMLHyperlinkElementUtils`, so
    ///   `link.protocol`/`link.host`/`link.href` are all `undefined` on it.
    #[test]
    fn document_routes_svg_anchors_through_the_link_runtime() {
        let doc = preview_document();
        assert!(doc.contains("toLowerCase() === \"a\""));
        assert!(doc.contains(r#"link.getAttribute("href")"#));
        assert!(doc.contains("new URL(href, doc.baseURI)"));
        for accessor in ["link.protocol", "link.host", "link.href"] {
            assert!(
                !doc.contains(accessor),
                "{accessor} is HTMLAnchorElement-only and is undefined on an SVG <a>"
            );
        }
    }

    /// Drift guard only: the per-load token must fail **closed**. The previewed
    /// page shares this realm, so a `Math.random()`/`Date.now()` fallback would be
    /// reproducible from inside the page — enough to forge an open-external
    /// message with no user click at all.
    #[test]
    fn document_has_no_predictable_token_fallback() {
        let doc = preview_document();
        assert!(doc.contains("window.crypto.getRandomValues"));
        assert!(!doc.contains("Math.random"));
    }
}
