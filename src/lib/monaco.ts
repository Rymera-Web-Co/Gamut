// Bundle Monaco locally instead of loading it from a CDN, so the diff editor
// works offline inside the Tauri app. A single editor worker is enough for a
// read-only diff editor (diff computation + syntax highlighting); we don't ship
// the per-language IntelliSense workers.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

/** Theme id used by the diff editors in dark mode. */
export const GITHUB_DARK = "github-dark-dimmed";

// A Monaco theme matching the app's GitHub "dark dimmed" palette so the diff
// editor blends with the surrounding UI.
monaco.editor.defineTheme(GITHUB_DARK, {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "adbac7", background: "22272e" },
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
    "editor.background": "#22272e",
    "editor.foreground": "#adbac7",
    "editorLineNumber.foreground": "#545d68",
    "editorLineNumber.activeForeground": "#adbac7",
    "editor.selectionBackground": "#316dca44",
    "editor.lineHighlightBackground": "#2d333b",
    "editorGutter.background": "#22272e",
    "editorWidget.background": "#2d333b",
    "editorWidget.border": "#444c56",
    "editorIndentGuide.background": "#373e47",
    "diffEditor.insertedTextBackground": "#347d3933",
    "diffEditor.removedTextBackground": "#e5534b33",
    "diffEditor.insertedLineBackground": "#347d3926",
    "diffEditor.removedLineBackground": "#e5534b26",
  },
});

loader.config({ monaco });
