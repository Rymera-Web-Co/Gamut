import { lazy, Suspense } from "react";
import type { DiffEditorProps, EditorProps } from "@monaco-editor/react";

import { ensureMonaco } from "@/lib/monaco";

// Lazy editors: the @monaco-editor/react component and the heavy "monaco" chunk
// are only fetched once one of these renders (a file opened in Files, or a diff
// shown in Review / History) rather than at app boot (#141). `ensureMonaco`
// runs first so the worker + theme + loader are configured before mount.
const Editor = lazy(async () => {
  await ensureMonaco();
  return { default: (await import("@monaco-editor/react")).Editor };
});

const DiffEditor = lazy(async () => {
  await ensureMonaco();
  return { default: (await import("@monaco-editor/react")).DiffEditor };
});

function EditorFallback() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted-foreground)]">
      Loading editor…
    </div>
  );
}

/** A Monaco code editor that loads on first use. Drop-in for `<Editor>`. */
export function CodeEditor(props: EditorProps) {
  return (
    <Suspense fallback={<EditorFallback />}>
      <Editor {...props} />
    </Suspense>
  );
}

/** A Monaco diff editor that loads on first use. Drop-in for `<DiffEditor>`. */
export function CodeDiffEditor(props: DiffEditorProps) {
  return (
    <Suspense fallback={<EditorFallback />}>
      <DiffEditor {...props} />
    </Suspense>
  );
}
