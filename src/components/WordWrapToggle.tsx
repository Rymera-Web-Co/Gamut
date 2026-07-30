import { WrapText } from "lucide-react";

import { useSetting } from "@/features/settings/controls";
import { cn } from "@/lib/utils";

/**
 * Global word-wrap quick toggle for a Monaco-backed editor header (#284, #295).
 * Reads/writes the shared `editorWordWrap` setting that `useEditorPrefs()` /
 * `useDiffEditorPrefs()` already map into Monaco's `wordWrap` option, so every
 * view that renders this control stays in lock-step with Settings → Appearance
 * and with each other (single global source of truth) — with no extra
 * rendering code and no per-view/per-file state.
 */
export function WordWrapToggle() {
  const [wordWrap, setWordWrap] = useSetting("editorWordWrap");

  return (
    <button
      aria-label="Word wrap"
      aria-pressed={wordWrap}
      title={`Word wrap: ${wordWrap ? "on" : "off"} (applies to all editors)`}
      onClick={() => setWordWrap(!wordWrap)}
      className={cn(
        "inline-flex h-7 items-center justify-center rounded-md px-2 transition-colors",
        wordWrap
          ? "bg-[var(--color-secondary)] text-[var(--color-secondary-foreground)]"
          : "text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]",
      )}
    >
      <WrapText className="size-3.5" />
    </button>
  );
}
