import { WrapText } from "lucide-react";

import { Segmented, useSetting } from "@/features/settings/controls";
import { cn } from "@/lib/utils";

/**
 * In-view diff controls for the Review tab (#284): a Side-by-side / Unified
 * layout switch plus a word-wrap quick toggle, rendered in the file-header
 * toolbar of both the working-tree and branch/PR review panes.
 *
 * Both controls write the same global settings that `useDiffEditorPrefs()`
 * already reads (`diffLayout`, `editorWordWrap`), so the mounted diff editor
 * updates instantly with no extra rendering code and the choice stays in lock-
 * step with the Settings → Diff & Review defaults (single source of truth). It
 * saves the round-trip into Settings just to flip a diff mid-review.
 */
export function DiffViewControls() {
  const [diffLayout, setDiffLayout] = useSetting("diffLayout");
  const [wordWrap, setWordWrap] = useSetting("editorWordWrap");

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Segmented
        value={diffLayout}
        onChange={setDiffLayout}
        options={[
          { value: "side-by-side", label: "Side by side", title: "Two-column split diff" },
          { value: "unified", label: "Unified", title: "Single-column inline diff" },
        ]}
      />
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
    </div>
  );
}
