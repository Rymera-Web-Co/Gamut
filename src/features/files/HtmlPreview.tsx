import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { toast } from "@/store/toast";
import { cn } from "@/lib/utils";
import { MSG_HTML, MSG_OPEN_EXTERNAL, MSG_READY, previewUrl } from "./previewProtocol";

/** How long to coalesce buffer changes before re-rendering the preview. */
const DEBOUNCE_MS = 400;
/** How long to wait for the frame's ready handshake before reporting failure. */
const READY_TIMEOUT_MS = 4000;
/** Minimum gap between two external-link opens (see `lastOpenRef`). */
const OPEN_INTERVAL_MS = 2000;

/**
 * Rendered preview of an HTML buffer, in an isolated sandboxed iframe (#296).
 *
 * The frame loads a constant bootstrap document from the app's own
 * `gamut-preview://` scheme (`src-tauri/src/preview.rs`) and is handed the buffer
 * over `postMessage`; nothing is ever written to disk, so the preview reflects
 * unsaved edits. `sandbox="allow-scripts"` with **no** `allow-same-origin` puts
 * the previewed page on an opaque origin: no storage, no cookies, no reach into
 * the app document, and no Tauri IPC. It is deliberately not `srcdoc` — a local
 * scheme would inherit the app's CSP and the previewed page's own scripts would
 * be refused in a shipped build.
 *
 * Each debounced change remounts the frame rather than re-writing into the live
 * one, so a render never inherits the previous render's globals or listeners.
 */
export function HtmlPreview({ html }: { html: string }) {
  // `id` increments per debounced change and keys — i.e. remounts — the frame
  // below; `html` is the debounce's comparison basis: the buffer the mounted
  // frame has actually been *delivered*, which is not the same as the buffer it
  // mounted with. The buffer typically arrives one render after the frame does
  // (FilesView's content-load effect runs after the commit that first renders
  // this branch), so the frame mounts with the old/empty text and gets the real
  // text on the handshake. Comparing against the mount value instead would then
  // see a difference and remount — re-running every previewed page's scripts,
  // animations and network calls a second time, with a visible blank flash.
  const [render, setRender] = useState({ id: 0, html });

  useEffect(() => {
    if (html === render.html) return;
    // Trailing-edge debounce: every change restarts the timer, so the value that
    // lands is always the latest one — the preview can't end up stale.
    const timer = setTimeout(() => setRender((r) => ({ id: r.id + 1, html })), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [html, render.html]);

  // The frame is handed the *live* buffer, not the debounced snapshot: what the
  // debounce rate-limits is how often a frame is remounted, and whichever frame
  // is up must answer its handshake with the text as it stands right now. Passing
  // the snapshot instead would show the previous file's bytes for a whole
  // debounce window after switching files.
  return (
    <PreviewFrame
      key={render.id}
      html={html}
      onDelivered={(delivered) =>
        setRender((r) => (r.html === delivered ? r : { ...r, html: delivered }))
      }
    />
  );
}

function PreviewFrame({
  html,
  onDelivered,
}: {
  html: string;
  onDelivered: (html: string) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Read at delivery time rather than captured, so the handshake always answers
  // with the buffer as it stands now.
  const htmlRef = useRef(html);
  htmlRef.current = html;
  // Ditto for the delivery callback: the message listener is installed once per
  // mount, so it must not close over the first render's prop.
  const onDeliveredRef = useRef(onDelivered);
  onDeliveredRef.current = onDelivered;
  // Adopted from the ready handshake, then required on everything the frame
  // posts afterwards.
  const tokenRef = useRef<string | null>(null);
  // When the last external link was opened. The previewed page can't reach this
  // — it lives in the parent — which is the point: with `allow-scripts` a page
  // can cover its whole viewport with a single `<a href>`, so any genuine click
  // anywhere in the pane opens a URL the user never saw. Rate-limiting the
  // bridge caps that at one open per `OPEN_INTERVAL_MS`.
  const lastOpenRef = useRef(0);
  const [ready, setReady] = useState(false);
  const src = useMemo(() => previewUrl(), []);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const frame = frameRef.current;
      // The frame has an opaque origin (no `allow-same-origin`), so `e.origin`
      // is the string "null" for every message it sends and is useless as a
      // check. Source identity against *this* frame's window is the real gate:
      // the previewed page shares the bootstrap's document, so anything it posts
      // arrives here too and must be validated before it can drive the app.
      if (frame == null || e.source == null || e.source !== frame.contentWindow) return;
      const data = e.data as { type?: unknown; token?: unknown; url?: unknown } | null;
      if (data == null || typeof data !== "object") return;

      if (data.type === MSG_READY) {
        // One handshake per mount: a second `ready` (which the previewed page
        // could forge, or cause for real with `location.reload()`) must not be
        // able to rotate the token. Refusing it leaves the frame holding a
        // document we will never deliver into again, so drop back to "not ready"
        // and let the timeout below explain the blank pane.
        if (tokenRef.current != null) {
          setReady(false);
          return;
        }
        if (typeof data.token !== "string" || data.token === "") return;
        tokenRef.current = data.token;
        setReady(true);
        const delivered = htmlRef.current;
        frame.contentWindow?.postMessage(
          { type: MSG_HTML, token: data.token, html: delivered },
          "*",
        );
        // Tell the parent which buffer this frame actually received, so the
        // debounce compares against that and not against the mount value.
        onDeliveredRef.current(delivered);
        return;
      }

      if (data.token == null || data.token !== tokenRef.current) return;

      if (data.type === MSG_OPEN_EXTERNAL) {
        // Validate and open the *same* string: `new URL` strips tabs/newlines and
        // lowercases the scheme and host, so handing the opener the raw text
        // would mean the string we checked isn't the string we open.
        const url = externalUrl(data.url);
        if (url == null) return;
        const now = Date.now();
        if (now - lastOpenRef.current < OPEN_INTERVAL_MS) return;
        lastOpenRef.current = now;
        // Same path every other external link in the app takes: the user's real
        // browser, never an in-app popup.
        openUrl(url).catch((e) => toast.error(`Couldn't open ${url} — ${String(e)}`));
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // A frame that never reports ready would otherwise be an unexplained blank
  // pane; surface it instead.
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setTimedOut(true), READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  return (
    <div className="relative h-full w-full bg-[var(--color-background)]">
      <iframe
        ref={frameRef}
        title="HTML preview"
        src={src}
        // `allow-scripts` and nothing else. In particular no `allow-same-origin`
        // (which would hand the page a real origin, storage and cookies) and no
        // popup tokens (`allow-popups-to-escape-sandbox` would let a popup become
        // an *unsandboxed* top-level document on this CSP-free origin — worse
        // than the frame we isolated). External links go up to the parent above.
        sandbox="allow-scripts"
        // Themed while the frame is still the (transparent) bootstrap, so there
        // is no white flash on a dark theme; white once a document has landed,
        // because that is the canvas a browser gives a page. `document.write`
        // discards the bootstrap's own stylesheet, so a page with no background
        // of its own paints straight onto this element — and its default black
        // text would be unreadable over the app's dark background.
        className={cn(
          "h-full w-full border-0",
          ready ? "bg-white" : "bg-[var(--color-background)]",
        )}
      />
      {!ready && timedOut && (
        <div
          role="status"
          className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-[var(--color-muted-foreground)]"
        >
          The HTML preview didn't load. Switch to Edit to see the file's source.
        </div>
      )}
    </div>
  );
}

/**
 * The normalised form of a real web URL, or `null` for anything else — never
 * `javascript:`, `file:`, … Returning the parsed `href` rather than a boolean is
 * deliberate: the caller must open exactly the string that was validated.
 */
function externalUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}
