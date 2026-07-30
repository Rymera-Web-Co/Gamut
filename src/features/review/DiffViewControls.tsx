import { WordWrapToggle } from "@/components/WordWrapToggle";
import { Segmented, useSetting } from "@/features/settings/controls";

/**
 * In-view diff controls for the Review tab (#284): a Side-by-side / Unified
 * layout switch plus a word-wrap quick toggle, rendered in the file-header
 * toolbar of both the working-tree and branch/PR review panes.
 *
 * Both controls write the same global settings that `useDiffEditorPrefs()`
 * already reads (`diffLayout`, `editorWordWrap`), so the mounted diff editor
 * updates instantly with no extra rendering code and the choice stays in lock-
 * step with the Settings → Diff & Review defaults (single source of truth). It
 * saves the round-trip into Settings just to flip a diff mid-review. The wrap
 * toggle is the shared `WordWrapToggle` (#295) — the Files tab header renders
 * the same component so the two stay visually and behaviourally identical.
 */
export function DiffViewControls() {
  const [diffLayout, setDiffLayout] = useSetting("diffLayout");

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
      <WordWrapToggle />
    </div>
  );
}
