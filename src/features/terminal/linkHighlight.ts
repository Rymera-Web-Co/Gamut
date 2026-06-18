import type { IDisposable, Terminal } from "@xterm/xterm";
import type { Theme } from "@/lib/theme";

/**
 * Matches `http(s)` URLs in terminal output. Kept deliberately broad — the
 * trailing-punctuation trim below handles the common cases (a URL ending a
 * sentence, wrapped in parens, etc.) without a baroque regex. The clickable
 * target is owned by `WebLinksAddon`; this regex only governs how far the
 * persistent underline extends, so an occasional one-character mismatch is
 * harmless.
 */
const URL_RE = /https?:\/\/[^\s]+/g;

/** Trailing characters that are almost never part of the intended URL. */
const TRAILING = /[.,;:!?'")\]}>]+$/;

/** Link accent per theme — GitHub's link blues, legible on our surfaces. */
export function linkColor(theme: Theme): string {
  return theme === "dark" ? "#539bf5" : "#0969da";
}

interface UrlHit {
  /** Absolute buffer row the segment lives on. */
  row: number;
  /** Start column (inclusive) within the row. */
  col: number;
  /** Width of the segment in cells. */
  width: number;
}

/**
 * Walk the rows currently in (or just above) the viewport, reconstruct logical
 * lines across soft-wraps, and return every URL as one or more per-row segments
 * — a single URL that wraps onto the next row yields one hit per physical row.
 *
 * Column math assumes single-width cells, which holds for the ASCII that makes
 * up URLs and ordinary log output. Wide (CJK) glyphs *preceding* a URL on the
 * same row could shift the underline slightly; this mirrors how `WebLinksAddon`
 * itself maps strings to columns, so the underline and the click target stay in
 * agreement.
 */
function scanVisibleUrls(term: Terminal): UrlHit[] {
  const buf = term.buffer.active;
  const cols = term.cols;
  const lastRow = Math.min(buf.viewportY + term.rows, buf.length);

  // Back up to the start of any logical line that begins above the viewport so
  // a URL split by the top edge is still matched in full.
  let firstRow = buf.viewportY;
  while (firstRow > 0 && buf.getLine(firstRow)?.isWrapped) firstRow--;

  const hits: UrlHit[] = [];
  let row = firstRow;
  while (row < lastRow) {
    // Gather this logical line: the row plus every following wrapped row.
    const startRow = row;
    let text = buf.getLine(row)?.translateToString(false, 0, cols) ?? "";
    row++;
    while (row < buf.length && buf.getLine(row)?.isWrapped) {
      text += buf.getLine(row)?.translateToString(false, 0, cols) ?? "";
      row++;
    }

    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(text))) {
      const url = m[0].replace(TRAILING, "");
      if (url.length < 8) continue; // shorter than "http://x"
      const start = m.index;
      const end = start + url.length;
      // Split the [start, end) range across the physical rows it spans.
      for (let i = start; i < end; ) {
        const segRow = startRow + Math.floor(i / cols);
        const segCol = i % cols;
        const segWidth = Math.min(end - i, cols - segCol);
        hits.push({ row: segRow, col: segCol, width: segWidth });
        i += segWidth;
      }
    }
  }
  return hits;
}

/** Handle returned by {@link attachLinkHighlighter}. */
export interface LinkHighlighter {
  /** Re-render highlights now (e.g. after a theme change). */
  refresh(): void;
  /** Remove listeners and tear down all decorations. */
  dispose(): void;
}

/**
 * Give clickable URLs a persistent, hover-independent treatment: the addon only
 * underlines on hover, and xterm has no link color in its theme, so we overlay
 * one decoration per URL row segment — tinted to the link accent and underlined
 * via the decoration's DOM element. Rescans are coalesced into an animation
 * frame and triggered by output (`onWriteParsed`) and scrolling (`onScroll`);
 * creating decorations triggers a render, not those events, so there's no loop.
 */
export function attachLinkHighlighter(
  term: Terminal,
  getColor: () => string,
): LinkHighlighter {
  let active: IDisposable[] = [];
  let frame = 0;
  let disposed = false;

  const clear = () => {
    for (const d of active) d.dispose();
    active = [];
  };

  const rescan = () => {
    frame = 0;
    if (disposed) return;
    clear();
    const color = getColor();
    const buf = term.buffer.active;
    const cursorAbs = buf.baseY + buf.cursorY;
    for (const hit of scanVisibleUrls(term)) {
      const marker = term.registerMarker(hit.row - cursorAbs);
      if (!marker) continue;
      const decoration = term.registerDecoration({
        marker,
        x: hit.col,
        width: hit.width,
        foregroundColor: color,
        layer: "bottom", // under the selection layer, so selection stays visible
      });
      if (!decoration) {
        marker.dispose();
        continue;
      }
      decoration.onRender((el) => {
        el.style.borderBottom = `1px solid ${color}`;
        el.style.boxSizing = "border-box";
        // The decoration is a passive cue; clicks belong to the link addon.
        el.style.pointerEvents = "none";
      });
      active.push(decoration, marker);
    }
  };

  const schedule = () => {
    if (frame || disposed) return;
    frame = requestAnimationFrame(rescan);
  };

  const listeners = [term.onWriteParsed(schedule), term.onScroll(schedule)];

  return {
    refresh: rescan,
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      for (const l of listeners) l.dispose();
      clear();
    },
  };
}
