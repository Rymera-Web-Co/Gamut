import { useState } from "react";
import { GitCompare } from "lucide-react";

import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/ui";
import { LocalReview } from "./LocalReview";

type Mode = "working" | "branch";

const MODES: { mode: Mode; label: string }[] = [
  { mode: "working", label: "Working tree" },
  { mode: "branch", label: "Branch vs base" },
];

export function ReviewView() {
  const repoId = useUiStore((s) => s.activeRepoId);
  const [mode, setMode] = useState<Mode>("working");

  if (repoId == null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <GitCompare className="size-8 text-[var(--color-muted-foreground)]" />
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Select a repository from the left to review local changes.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
        {MODES.map(({ mode: m, label }) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={cn(
              "rounded-md px-3 py-1 text-sm transition-colors",
              mode === m
                ? "bg-[var(--color-secondary)] text-[var(--color-secondary-foreground)]"
                : "text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)]",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">
        <LocalReview key={`${repoId}-${mode}`} repoId={repoId} source={mode} />
      </div>
    </div>
  );
}
