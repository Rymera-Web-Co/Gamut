// xterm palette + contrast tuning, shared by the terminal session manager and
// the pane's root surface. Extracted from TerminalPane for navigability (#143).
import type { Theme } from "@/lib/theme";

export const FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, "Cascadia Code", "Roboto Mono", monospace';

/**
 * xterm palette tuned to the app's light/dark surfaces.
 *
 * The full 16-colour ANSI palette is defined explicitly (issue #120). Without
 * it xterm.js falls back to its built-in defaults, where `white` ≈ #e5e5e5 and
 * `brightWhite` ≈ #ffffff — and TUIs that assume a dark terminal (e.g. Claude
 * Code printing diffs) emit white / bright-white text that lands near-invisible
 * on the light surface. The light palette below (GitHub-light) gives the named
 * ANSI colours dark, readable values. This only covers the ANSI-16 case though;
 * programs that emit *truecolor* (24-bit) white bypass the palette entirely, so
 * legibility is ultimately guaranteed by `xtermContrast()` (see below).
 * The dark palette (GitHub-dark-dimmed) matches the dark surface.
 */
export function xtermTheme(theme: Theme) {
  return theme === "dark"
    ? {
        background: "#14161d",
        foreground: "#adbac7",
        cursor: "#adbac7",
        selectionBackground: "#16c2ae44",
        black: "#545d68",
        red: "#f47067",
        green: "#57ab5a",
        yellow: "#c69026",
        blue: "#539bf5",
        magenta: "#b083f0",
        cyan: "#39c5cf",
        white: "#909dab",
        brightBlack: "#636e7b",
        brightRed: "#ff938a",
        brightGreen: "#6bc46d",
        brightYellow: "#daaa3f",
        brightBlue: "#6cb6ff",
        brightMagenta: "#dcbdfb",
        brightCyan: "#56d4dd",
        brightWhite: "#cdd9e5",
      }
    : {
        background: "#ffffff",
        foreground: "#2b2b28",
        cursor: "#2b2b28",
        selectionBackground: "#00a89633",
        black: "#24292e",
        red: "#d73a49",
        green: "#28a745",
        yellow: "#b08800",
        blue: "#0366d6",
        magenta: "#6f42c1",
        cyan: "#1b7c83",
        // `white` is the normal-intensity light colour TUIs use for body text;
        // on a light surface it must be dark, not near-white.
        white: "#6a737d",
        brightBlack: "#959da5",
        brightRed: "#cb2431",
        brightGreen: "#22863a",
        brightYellow: "#b08800",
        brightBlue: "#005cc5",
        brightMagenta: "#5a32a3",
        brightCyan: "#3192aa",
        // bright-white text (e.g. Claude Code's diff body) stays dark & readable.
        brightWhite: "#24292e",
      };
}

/**
 * Minimum foreground/background contrast xterm enforces per cell (issue #120).
 *
 * The palette above only governs the 16 named ANSI colours; programs that print
 * truecolor white (Claude Code's diffs do) sail straight past it and render as
 * literal #ffffff, invisible on the light surface. `minimumContrastRatio` makes
 * xterm adjust each cell's foreground against *that cell's own background* until
 * the ratio is met — so white-on-light gets darkened to readable, while a cell a
 * program paints with its own dark background (black-bg + white text) already
 * clears the ratio and is left untouched. We enforce WCAG AA (4.5) in light mode
 * and leave dark mode at the default (1 = off), since it already has the
 * contrast TUIs assume and adjusting it would shift their tuned colours.
 */
export function xtermContrast(theme: Theme): number {
  return theme === "dark" ? 1 : 4.5;
}
