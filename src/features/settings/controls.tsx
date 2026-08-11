import { useEffect, useState, type ReactNode } from "react";

import { Input } from "@/components/ui/input";
import {
  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useSettings, type Settings } from "@/lib/settings";

// ---- Layout primitives ----------------------------------------------------

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function PanelTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-1 text-base font-semibold">{children}</h2>;
}

export function Divider() {
  return <div className="my-1 border-t" />;
}

// ---- Controls -------------------------------------------------------------

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-md border p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          title={opt.title}
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors",
            value === opt.value
              ? "bg-[var(--color-secondary)] text-[var(--color-secondary-foreground)]"
              : "text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** Number input with local edit state; commits a clamped value on valid input. */
export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  integer = true,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  /** Whether to coerce input to a whole number (all current settings are). */
  integer?: boolean;
}) {
  const [text, setText] = useState(String(value));
  // Re-sync when the source changes (e.g. reset-to-defaults).
  useEffect(() => setText(String(value)), [value]);

  const commit = (raw: string) => {
    setText(raw);
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) return;
    // Don't commit a fractional value for an integer setting (the backend
    // parses these as `usize`/`u64` and would silently fall back to default).
    if (integer && !Number.isInteger(n)) return;
    let clamped = n;
    if (min != null) clamped = Math.max(min, clamped);
    if (max != null) clamped = Math.min(max, clamped);
    onChange(clamped);
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        className="h-8 w-20 text-sm"
        value={text}
        min={min}
        max={max}
        step={step}
        onChange={(e) => commit(e.target.value)}
        onBlur={() => setText(String(value))}
      />
      {suffix && <span className="text-xs text-[var(--color-muted-foreground)]">{suffix}</span>}
    </div>
  );
}

export function TextField({
  value,
  onChange,
  placeholder,
  wide,
  onBlur,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  wide?: boolean;
  /** Commit-on-blur for callers that save on blur rather than on every
   * keystroke (e.g. a field backed by a round-tripping IPC write). */
  onBlur?: () => void;
  /** Accessible name, for a field with no associated `<label>` element. */
  ariaLabel?: string;
}) {
  return (
    <Input
      className={cn("h-8 text-sm", wide ? "w-72" : "w-48")}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      aria-label={ariaLabel}
    />
  );
}

export function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-[var(--color-primary)]" : "bg-[var(--color-input)]",
      )}
    >
      <span
        className={cn(
          "inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  /** Accessible name, for a select with no associated `<label>` element. */
  ariaLabel?: string;
}) {
  return (
    <SelectRoot value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}

/** Small typed binding helper for a setting key. */
export function useSetting<K extends keyof Settings>(key: K) {
  const value = useSettings((s) => s.values[key]);
  const set = useSettings((s) => s.set);
  return [value, (v: Settings[K]) => set(key, v)] as const;
}
