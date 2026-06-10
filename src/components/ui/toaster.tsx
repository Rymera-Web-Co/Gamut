import { X } from "lucide-react";

import { useToasts } from "@/store/toast";
import { cn } from "@/lib/utils";

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-lg",
            "bg-[var(--color-background)]",
            t.variant === "error" && "border-[var(--color-destructive)]",
          )}
        >
          <span
            className={cn(
              "min-w-0 flex-1 break-words",
              t.variant === "error" && "text-[var(--color-destructive)]",
              t.variant === "success" && "text-[#16a34a]",
            )}
          >
            {t.message}
          </span>
          <button
            onClick={() => dismiss(t.id)}
            className="shrink-0 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            aria-label="Dismiss"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
