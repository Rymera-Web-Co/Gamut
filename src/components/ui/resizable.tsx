import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";

import { cn } from "@/lib/utils";

export { Panel, PanelGroup };

/** A thin vertical divider with a generous (invisible) hit area. */
export function ResizeHandle({ className }: { className?: string }) {
  return (
    <PanelResizeHandle
      className={cn(
        "relative z-10 w-px bg-[var(--color-border)] outline-none transition-colors",
        "data-[resize-handle-state=hover]:bg-[var(--color-ring)]",
        "data-[resize-handle-state=drag]:bg-[var(--color-primary)]",
        // widen the grab zone without affecting layout
        "after:absolute after:inset-y-0 after:-left-1.5 after:-right-1.5 after:content-['']",
        className,
      )}
    />
  );
}
