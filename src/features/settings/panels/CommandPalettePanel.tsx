import { ChevronDown, ChevronUp, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { parsePaletteOrder, PALETTE_CATEGORIES, type PaletteCategory } from "@/lib/settings";
import { PanelTitle, useSetting } from "../controls";

const PALETTE_CATEGORY_LABELS: Record<PaletteCategory, string> = {
  repos: "Repositories",
  groups: "Groups",
  terminals: "Terminals",
};

export function CommandPalettePanel() {
  const [paletteCategoryOrder, setOrder] = useSetting("paletteCategoryOrder");
  const order = parsePaletteOrder(paletteCategoryOrder);
  const isDefault = order.join(",") === PALETTE_CATEGORIES.join(",");

  // Swap a category with its neighbour, persisting the canonical comma-joined
  // string (re-parsed on read, so a corrupt stored value can never stick).
  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next.join(","));
  };

  return (
    <div>
      <PanelTitle>Command palette</PanelTitle>
      <p className="mb-3 text-xs text-[var(--color-muted-foreground)]">
        Order the result categories shown in the ⌘/Ctrl+K palette. The first category renders first,
        so its top result is pre-selected when the palette opens. Terminals or groups needing
        attention are always pinned above these.
      </p>
      <div className="rounded-md border">
        {order.map((cat, i) => (
          <div
            key={cat}
            className="flex items-center justify-between gap-4 border-b px-3 py-2 last:border-b-0"
          >
            <span className="text-sm">{PALETTE_CATEGORY_LABELS[cat]}</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => move(i, -1)}
                disabled={i === 0}
                title="Move up"
                className="flex size-7 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)] disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronUp className="size-4" />
              </button>
              <button
                onClick={() => move(i, 1)}
                disabled={i === order.length - 1}
                title="Move down"
                className="flex size-7 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)] disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronDown className="size-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-[var(--color-muted-foreground)]"
          disabled={isDefault}
          onClick={() => setOrder(PALETTE_CATEGORIES.join(","))}
        >
          <RotateCcw className="size-3.5" />
          Reset order
        </Button>
      </div>
    </div>
  );
}
