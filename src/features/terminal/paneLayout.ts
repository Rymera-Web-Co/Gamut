import type { SplitDirection } from "@/store/ui";

/** The style slot for one split pane: pane `i` of `n` in `direction`. */
export interface PaneSlot {
  left: string;
  width: string;
  top: string;
  height: string;
  borderLeft: string;
  borderTop: string;
}

const DIVIDER = "1px solid var(--color-border)";

/**
 * Absolute-positioning slot for a split pane (#316). Both axes (and both
 * divider borders) are always assigned: a pane node outlives its tab's split
 * direction — a split can collapse to one pane and re-split the other way —
 * so every pass must overwrite what the previous direction set.
 */
export function paneSlot(direction: SplitDirection, i: number, n: number): PaneSlot {
  if (direction === "column") {
    return {
      left: "0",
      width: "100%",
      top: `${(i * 100) / n}%`,
      height: `${100 / n}%`,
      borderLeft: "",
      borderTop: i > 0 ? DIVIDER : "",
    };
  }
  return {
    left: `${(i * 100) / n}%`,
    width: `${100 / n}%`,
    top: "0",
    height: "100%",
    borderLeft: i > 0 ? DIVIDER : "",
    borderTop: "",
  };
}
