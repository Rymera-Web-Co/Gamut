import { useEffect, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Viewport coordinates at which to open the menu, or null when closed. */
export interface ContextMenuPosition {
  x: number;
  y: number;
}

/**
 * A lightweight cursor-anchored context menu. Render it once and drive it with
 * a position captured from an `onContextMenu` handler; closes on outside click,
 * right-click, or Escape.
 */
export function ContextMenu({
  at,
  onClose,
  children,
}: {
  at: ContextMenuPosition | null;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!at) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [at, onClose]);

  if (!at) return null;

  return (
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        role="menu"
        className="absolute min-w-44 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-popover)] py-1 text-sm text-[var(--color-popover-foreground)] shadow-md"
        style={{ left: at.x, top: at.y }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function ContextMenuItem({
  onClick,
  className,
  children,
}: {
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-foreground)] transition-colors",
        "hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-foreground)]",
        "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-[var(--color-muted-foreground)]",
        className,
      )}
    >
      {children}
    </button>
  );
}
