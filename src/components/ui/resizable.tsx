import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";

import { cn } from "@/lib/utils";

export { Panel, PanelGroup };

/**
 * A thin divider with a generous (invisible) hit area. Vertical by default (for
 * a horizontal `PanelGroup`); pass `horizontal` for a row divider (vertical
 * `PanelGroup`, e.g. the bottom terminal pane).
 */
export function ResizeHandle({
  className,
  horizontal = false,
}: {
  className?: string;
  horizontal?: boolean;
}) {
  return (
    <PanelResizeHandle
      className={cn(
        "relative z-10 bg-[var(--color-border)] outline-none transition-colors",
        "data-[resize-handle-state=hover]:bg-[var(--color-ring)]",
        "data-[resize-handle-state=drag]:bg-[var(--color-primary)]",
        horizontal
          ? // full-width row divider; widen the grab zone vertically
            "h-px after:absolute after:inset-x-0 after:-top-1.5 after:-bottom-1.5 after:content-['']"
          : // full-height column divider; widen the grab zone horizontally
            "w-px after:absolute after:inset-y-0 after:-left-1.5 after:-right-1.5 after:content-['']",
        className,
      )}
    />
  );
}
