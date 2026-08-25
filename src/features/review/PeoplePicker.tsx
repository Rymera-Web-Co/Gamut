import { useState } from "react";
import { Check, Loader2, Pencil } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { useCollaborators } from "./api";
import { Avatar } from "./reviewShared";

/**
 * Multi-select popover for choosing PR reviewers/assignees from the repo's
 * collaborators (#334). Modeled on `BaseBranchPicker`, but toggling a row
 * keeps the popover open (multi-select) instead of closing it, and there is
 * no "auto"/none option — every row is independently checked/unchecked.
 */
export function PeoplePicker({
  repoId,
  label,
  isChecked,
  onToggle,
  isRowDisabled,
  rowDisabledReason,
}: {
  repoId: number;
  /** Accessible name for the trigger, e.g. "Edit reviewers" / "Edit assignees". */
  label: string;
  isChecked: (login: string) => boolean;
  onToggle: (login: string, checked: boolean) => void;
  /** Whether a mutation is already in flight for this login (blocks a 2nd click). */
  isRowDisabled?: (login: string) => boolean;
  /**
   * Why this login can never be toggled here — e.g. a reviewer who already
   * submitted a review, or someone GitHub refuses as a reviewer (#334).
   * Returning a string disables the row AND shows the text as the reason; an
   * in-flight row (`isRowDisabled`) is disabled without any reason text.
   */
  rowDisabledReason?: (login: string) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  // Collaborator list loads lazily while the popover is open (#334).
  const collaborators = useCollaborators(repoId, open);

  const all = collaborators.data ?? [];
  const q = filter.toLowerCase();
  const people = all.filter((p) => p.login.toLowerCase().includes(q));

  // The query is gated on `open`, so it sits in `pending` with no fetch until
  // the popover opens; inside an open popover, pending-or-fetching means the
  // list is still on its way (#334).
  const loading = collaborators.isPending || collaborators.isFetching;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFilter("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          title={label}
          aria-label={label}
          className="text-[var(--color-muted-foreground)] transition-colors hover:text-[var(--color-foreground)]"
        >
          <Pencil className="size-3.5" />
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-64 p-0" align="end" aria-label={label}>
        <div className="p-2">
          <Input
            autoFocus
            placeholder="Filter people…"
            aria-label="Filter people"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8"
          />
        </div>
        <div className="max-h-64 overflow-auto border-t" role="group" aria-label={label}>
          {collaborators.isError ? (
            <p className="p-3 text-center text-sm text-[var(--color-destructive)]">
              Couldn&rsquo;t load collaborators.
            </p>
          ) : loading ? (
            <p className="flex items-center justify-center gap-2 p-3 text-sm text-[var(--color-muted-foreground)]">
              <Loader2 className="size-3 animate-spin" /> Loading…
            </p>
          ) : all.length === 0 ? (
            <p className="p-3 text-center text-sm text-[var(--color-muted-foreground)]">
              No collaborators.
            </p>
          ) : people.length === 0 ? (
            <p className="p-3 text-center text-sm text-[var(--color-muted-foreground)]">
              No matching people.
            </p>
          ) : (
            people.map((p) => {
              const checked = isChecked(p.login);
              const reason = rowDisabledReason?.(p.login) ?? null;
              const disabled = reason != null || (isRowDisabled?.(p.login) ?? false);
              return (
                <button
                  key={p.login}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  disabled={disabled}
                  title={reason ? `${p.login} — ${reason}` : p.login}
                  onClick={() => onToggle(p.login, !checked)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-accent)] disabled:opacity-50"
                >
                  <span className="w-4 shrink-0">{checked && <Check className="size-3.5" />}</span>
                  <Avatar src={p.avatar} name={p.login} size={18} />
                  <span className="min-w-0 flex-1 truncate">{p.login}</span>
                  {reason && (
                    <span className="shrink-0 text-xs text-[var(--color-muted-foreground)]">
                      {reason}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
