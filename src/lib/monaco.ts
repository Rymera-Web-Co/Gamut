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

loader.config({ monaco });
