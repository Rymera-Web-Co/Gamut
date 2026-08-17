// Theme id + data for the diff/code editors, kept in a lightweight module with
// no `monaco-editor` runtime import so views can reference the theme name
// without pulling Monaco into the initial bundle (#141). The heavy setup that
// actually registers this theme lives in `@/lib/monaco` and runs lazily.
import type { editor } from "monaco-editor";

/** Theme id used by the editors in dark mode. */
export const GAMUT_DARK = "gamut-dark";

// A Monaco theme matching the app's dark palette (see `index.css`) so the
// editor blends with the surrounding UI. Syntax colours stay GitHub-dimmed —
// they read well on the darker surface — while the chrome (background, gutter,
// widgets, selection) uses the app's surface and accent tokens.
export const gamutDarkTheme: editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "c3c6d6", background: "14161d" },
    { token: "comment", foreground: "768390", fontStyle: "italic" },
    { token: "keyword", foreground: "f47067" },
    { token: "operator", foreground: "f47067" },
    { token: "string", foreground: "96d0ff" },
    { token: "number", foreground: "6cb6ff" },
    { token: "constant", foreground: "6cb6ff" },
    { token: "type", foreground: "f69d50" },
    { token: "type.identifier", foreground: "f69d50" },
    { token: "function", foreground: "dcbdfb" },
    { token: "variable", foreground: "adbac7" },
    { token: "tag", foreground: "8ddb8c" },
    { token: "attribute.name", foreground: "6cb6ff" },
    { token: "attribute.value", foreground: "96d0ff" },
    { token: "delimiter", foreground: "adbac7" },
  ],
  colors: {
    "editor.background": "#14161d",
    "editor.foreground": "#c3c6d6",
    "editorLineNumber.foreground": "#6b7089",
    "editorLineNumber.activeForeground": "#e7e8f0",
    "editor.selectionBackground": "#16c2ae33",
    "editor.lineHighlightBackground": "#1a1c25",
    "editorGutter.background": "#14161d",
    "editorWidget.background": "#1a1c25",
    "editorWidget.border": "#262935",
    "editorIndentGuide.background": "#20232d",
    "diffEditor.insertedTextBackground": "#16c2ae2e",
    "diffEditor.removedTextBackground": "#e5645a33",
    "diffEditor.insertedLineBackground": "#16c2ae21",
    "diffEditor.removedLineBackground": "#e5645a26",
  },
};
