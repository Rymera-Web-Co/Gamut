import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { EDGE, fitMenu, type ContextMenuPosition } from "@/lib/fitMenu";
import { cn } from "@/lib/utils";

export type { ContextMenuPosition };

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
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<ContextMenuPosition | null>(null);

  // Measure before paint, then keep the whole menu inside the viewport.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!at || !el) {
      setPos(null);
      return;
    }
    setPos(fitMenu(at, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight));
  }, [at]);

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
        ref={menuRef}
        className="absolute min-w-44 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-popover)] py-1 text-sm text-[var(--color-popover-foreground)] shadow-md"
        style={{
          left: (pos ?? at).x,
          top: (pos ?? at).y,
          maxHeight: `calc(100vh - ${EDGE * 2}px)`,
          visibility: pos ? undefined : "hidden",
        }}
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
