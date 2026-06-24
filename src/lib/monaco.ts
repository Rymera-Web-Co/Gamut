// Bundle Monaco locally instead of loading it from a CDN, so the editors work
// offline inside the Tauri app. A single editor worker is enough for the
// read-only diff editor and the Files code editor (diff computation + syntax
// highlighting); we don't ship the per-language IntelliSense workers.
//
// Monaco is the heaviest dependency in the app, and the editor only appears
// once the user opens Files / Review / History. So nothing here is imported at
// startup: `ensureMonaco` dynamically imports Monaco, its worker, and the
// @monaco-editor/react loader on first editor use, keeping the multi-megabyte
// "monaco" chunk out of the cold-start path (#141). The lazy editor wrappers in
// `@/components/MonacoEditor` await this before rendering.
import { GITHUB_DARK, githubDarkTheme } from "./monacoTheme";

let setup: Promise<void> | undefined;

/** Idempotently load Monaco, wire its web worker, register the app theme, and
 *  point @monaco-editor/react's loader at the bundled instance. The promise is
 *  cached so concurrent editors (e.g. Files + a diff) share one initialization. */
export function ensureMonaco(): Promise<void> {
  setup ??= (async () => {
    const [monaco, { loader }, { default: EditorWorker }] = await Promise.all([
      import("monaco-editor"),
      import("@monaco-editor/react"),
      import("monaco-editor/esm/vs/editor/editor.worker?worker"),
    ]);

    self.MonacoEnvironment = {
      getWorker() {
        return new EditorWorker();
      },
    };

    monaco.editor.defineTheme(GITHUB_DARK, githubDarkTheme);
    loader.config({ monaco });
    await loader.init();
  })();
  return setup;
}
