import type { LucideIcon } from "lucide-react";

interface PlaceholderProps {
  icon: LucideIcon;
  title: string;
  milestone: string;
  description: string;
}

/** Temporary empty-state used by feature views until they're implemented. */
export function Placeholder({
  icon: Icon,
  title,
  milestone,
  description,
}: PlaceholderProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <Icon className="size-10 text-[var(--color-muted-foreground)]" />
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">{title}</h1>
        <span className="rounded-full border px-2 py-0.5 text-xs text-[var(--color-muted-foreground)]">
          {milestone}
        </span>
      </div>
      <p className="max-w-md text-sm text-[var(--color-muted-foreground)]">
        {description}
      </p>
    </div>
  );
}
