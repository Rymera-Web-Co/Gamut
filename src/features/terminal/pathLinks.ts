import type { IBufferRange, IDisposable, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { URL_RE } from "./linkHighlight";

/**
 * File-path detection for terminal output (#255). Terminal text carries no
 * markup, so this is heuristic: we match tokens that *look* like paths and let
 * the click handler confirm they exist on disk (a non-existent candidate
 * resolves to nothing, so the click is a harmless no-op). Two shapes are
 * recognized, tuned to keep everyday text (`and/or`, `12/31`, fractions) inert:
 *
 *  1. **Rooted** — starting with `/`, `~/`, `./`, or `../` (e.g. `/etc/hosts`,
 *     `~/.bashrc`, `./src/foo`). The leading anchor is a strong path signal, so
 *     no extension is required.
 *  2. **cwd-relative** — a token with an internal `/` **and** a final segment
 *     bearing a dotted extension (e.g. `src/foo.ts`, `pkg/mod/file.rs`). The
 *     extension is what separates a real path from `and/or` or `12/31`.
 *
 * A trailing `:line[:col]` suffix (compiler / test / grep output) is matched so
 * the whole token underlines, and stripped by {@link stripLineSuffix} before
 * resolution so the file still opens. Windows backslash paths are out of scope
 * for this first cut — forward-slash paths only.
 */
const SEG = "[\\w.@+~-]+";
export const PATH_RE = new RegExp(
  "(?:" +
    // 1. rooted: an anchor (`/`, `~/`, `./`, `../`), then one or more segments.
    `(?:~\\/|\\.\\.?\\/|\\/)${SEG}(?:\\/${SEG})*` +
    "|" +
    // 2. relative: at least one slash and a final segment with a dotted
    //    extension — the extension is what separates a path from `and/or`.
    `${SEG}(?:\\/${SEG})*\\/[\\w.@+~-]*\\.[\\w@+~-]+` +
    ")" +
    // Optional `:line[:col]` suffix (compiler / test / grep output).
    "(?::\\d+){0,2}",
  "g",
);

/** Path-continuation chars — a match preceded by one isn't a token boundary. */
const PATH_CHAR = /[\w./@+~-]/;

/** A matched `:line[:col]` suffix to strip before resolving the file path. */
const LINE_SUFFIX_RE = /(?::\d+){1,2}$/;

/**
 * Trailing characters that are almost never part of the intended path (sentence
 * punctuation, wrapping brackets). `:` is deliberately excluded — it's handled
 * as the optional line/column suffix instead.
 */
const TRAILING = /[.,;!?'")\]}>]+$/;

/** A path hit within a scanned string: its char offset and cleaned text. */
export interface PathMatch {
  index: number;
  text: string;
}

/**
 * Every path-like token in `text`, cleaned of trailing punctuation and skipping
 * any hit that overlaps a URL (so the path portion of `https://…/a/b.ts` isn't
 * treated as a standalone file). `urlRanges` are `[start, end)` char offsets of
 * URLs in the same string — the caller computes them once with {@link URL_RE}.
 */
export function matchPaths(text: string, urlRanges: [number, number][] = []): PathMatch[] {
  const hits: PathMatch[] = [];
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(text))) {
    const index = m.index;
    const raw = m[0];
    // Only start at a token boundary, so a mid-word slash (`and/or`, `12/31`)
    // isn't read as an absolute path. Done here rather than with a regex
    // lookbehind, which throws at construction on older WebKit engines.
    if (index > 0 && PATH_CHAR.test(text[index - 1])) continue;
    // Keep any `:line:col` suffix (so it underlines) but trim sentence
    // punctuation after it.
    const trimmed = raw.replace(TRAILING, "");
    if (trimmed.length < 2) continue;
    const end = index + trimmed.length;
    // Skip candidates that fall inside a URL — that's the URL provider's job.
    if (urlRanges.some(([s, e]) => index < e && end > s)) continue;
    hits.push({ index, text: trimmed });
  }
  return hits;
}

/** URL `[start, end)` char offsets in `text`, for {@link matchPaths} exclusion. */
export function urlRangesIn(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

/**
 * Strip a trailing `:line[:col]` suffix from a path token, returning the bare
 * path plus the 1-based line when present. Tools print `src/foo.ts:42:10`; the
 * file still opens on the stripped path (jumping to the exact line is a
 * follow-up — see #255).
 */
export function stripLineSuffix(token: string): { path: string; line?: number } {
  const m = token.match(LINE_SUFFIX_RE);
  if (!m) return { path: token };
  const line = Number(m[0].slice(1).split(":")[0]);
  return { path: token.slice(0, m.index), line: Number.isFinite(line) ? line : undefined };
}

/**
 * Rebuild the logical line containing buffer row `row` (0-based) — the row plus
 * any soft-wrapped continuations above and below it — as one string, and report
 * the physical row its first character sits on. Mirrors the wrapped-line
 * handling in `linkHighlight.ts` so underline and click agree.
 */
function logicalLine(term: Terminal, row: number): { text: string; startRow: number } {
  const buf = term.buffer.active;
  const cols = term.cols;
  let startRow = row;
  while (startRow > 0 && buf.getLine(startRow)?.isWrapped) startRow--;
  let text = buf.getLine(startRow)?.translateToString(false, 0, cols) ?? "";
  let r = startRow + 1;
  while (r < buf.length && buf.getLine(r)?.isWrapped) {
    text += buf.getLine(r)?.translateToString(false, 0, cols) ?? "";
    r++;
  }
  return { text, startRow };
}

/**
 * An xterm link provider for local file paths (#255). Unlike `WebLinksAddon` —
 * whose `LinkComputer` validates every match with `new URL()`, so file paths are
 * always rejected — this returns links for the {@link PATH_RE} heuristic and
 * defers real existence/routing to `activate`. Column math assumes single-width
 * cells, matching `linkHighlight.ts`; paths are ASCII, so this holds.
 */
export function registerPathLinkProvider(
  term: Terminal,
  activate: (path: string) => void,
): IDisposable {
  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const cols = term.cols;
      const { text, startRow } = logicalLine(term, bufferLineNumber - 1);
      const links: ILink[] = [];
      for (const hit of matchPaths(text, urlRangesIn(text))) {
        const start = hit.index;
        const last = start + hit.text.length - 1;
        const range: IBufferRange = {
          start: { x: (start % cols) + 1, y: startRow + Math.floor(start / cols) + 1 },
          end: { x: (last % cols) + 1, y: startRow + Math.floor(last / cols) + 1 },
        };
        links.push({
          range,
          text: hit.text,
          activate(event, linkText) {
            // Match the URL links: only a cmd/ctrl-click opens, so plain clicks
            // and drag-selection are undisturbed.
            if (!(event.metaKey || event.ctrlKey)) return;
            activate(linkText);
          },
        });
      }
      callback(links.length ? links : undefined);
    },
  };
  return term.registerLinkProvider(provider);
}
