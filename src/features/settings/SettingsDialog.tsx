import { useEffect, useState, type ReactNode } from "react";
import {
  GitCompare,
  GitFork,
  Monitor,
  Moon,
  Palette,
  RotateCcw,
  SquareTerminal,
  Sun,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useSettings, type Settings } from "@/lib/settings";
import { useTheme, type ThemePreference } from "@/lib/theme";
import { useUiStore } from "@/store/ui";

const CATEGORIES = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "diff", label: "Diff & Review", icon: GitCompare },
  { id: "git", label: "Git & Repos", icon: GitFork },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const [category, setCategory] = useState<CategoryId>("appearance");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[32rem] max-h-[85vh] w-full max-w-3xl gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Application preferences, backed by the local settings store.
        </DialogDescription>

        {/* Category rail */}
        <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r bg-[var(--color-muted)]/30 p-2">
          <div className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
            Settings
          </div>
          {CATEGORIES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setCategory(id)}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                category === id
                  ? "bg-[var(--color-secondary)] text-[var(--color-secondary-foreground)]"
                  : "text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]",
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
          <div className="mt-auto px-1 pt-2">
            <ResetButton />
          </div>
        </nav>

        {/* Content */}
        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          {category === "appearance" && <AppearancePanel />}
          {category === "diff" && <DiffPanel />}
          {category === "git" && <GitPanel />}
          {category === "terminal" && <TerminalPanel />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- Layout primitives ----------------------------------------------------

function Field({
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
        {hint && (
          <div className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
            {hint}
          </div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function PanelTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-1 text-base font-semibold">{children}</h2>
  );
}

function Divider() {
  return <div className="my-1 border-t" />;
}

// ---- Controls -------------------------------------------------------------

function Segmented<T extends string>({
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
function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  const [text, setText] = useState(String(value));
  // Re-sync when the source changes (e.g. reset-to-defaults).
  useEffect(() => setText(String(value)), [value]);

  const commit = (raw: string) => {
    setText(raw);
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) return;
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
      {suffix && (
        <span className="text-xs text-[var(--color-muted-foreground)]">
          {suffix}
        </span>
      )}
    </div>
  );
}

function TextField({
  value,
  onChange,
  placeholder,
  wide,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  wide?: boolean;
}) {
  return (
    <Input
      className={cn("h-8 text-sm", wide ? "w-72" : "w-48")}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Toggle({
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
        "relative h-5 w-9 rounded-full transition-colors",
        checked ? "bg-[var(--color-primary)]" : "bg-[var(--color-input)]",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-4 rounded-full bg-white transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/** Small typed binding helper for a setting key. */
function useSetting<K extends keyof Settings>(key: K) {
  const value = useSettings((s) => s.values[key]);
  const set = useSettings((s) => s.set);
  return [value, (v: Settings[K]) => set(key, v)] as const;
}

// ---- Panels ---------------------------------------------------------------

function AppearancePanel() {
  const preference = useTheme((s) => s.preference);
  const setPreference = useTheme((s) => s.setPreference);
  const [editorFontSize, setEditorFontSize] = useSetting("editorFontSize");
  const [editorFontFamily, setEditorFontFamily] = useSetting("editorFontFamily");
  const [toastTimeout, setToastTimeout] = useSetting("toastTimeout");

  return (
    <div>
      <PanelTitle>Appearance</PanelTitle>
      <Field label="Theme" hint="System follows your OS appearance.">
        <Segmented<ThemePreference>
          value={preference}
          onChange={setPreference}
          options={[
            { value: "light", label: <Sun className="size-3.5" />, title: "Light" },
            { value: "dark", label: <Moon className="size-3.5" />, title: "Dark" },
            {
              value: "system",
              label: <Monitor className="size-3.5" />,
              title: "System",
            },
          ]}
        />
      </Field>
      <Divider />
      <Field label="Editor font size">
        <NumberField
          value={editorFontSize}
          onChange={setEditorFontSize}
          min={8}
          max={32}
          suffix="px"
        />
      </Field>
      <Field
        label="Editor font family"
        hint="Leave blank for the editor default."
      >
        <TextField
          value={editorFontFamily}
          onChange={setEditorFontFamily}
          placeholder="e.g. JetBrains Mono"
        />
      </Field>
      <Divider />
      <Field label="Toast auto-dismiss">
        <NumberField
          value={toastTimeout}
          onChange={setToastTimeout}
          min={1000}
          max={60000}
          step={500}
          suffix="ms"
        />
      </Field>
    </div>
  );
}

function DiffPanel() {
  const [diffLayout, setDiffLayout] = useSetting("diffLayout");
  const [reviewMode, setReviewMode] = useSetting("reviewMode");

  return (
    <div>
      <PanelTitle>Diff &amp; Review</PanelTitle>
      <Field label="Default diff layout">
        <Segmented
          value={diffLayout}
          onChange={setDiffLayout}
          options={[
            { value: "side-by-side", label: "Side by side" },
            { value: "unified", label: "Unified" },
          ]}
        />
      </Field>
      <Divider />
      <Field
        label="Default review mode"
        hint="Which view a repository's Review tab opens in."
      >
        <Segmented
          value={reviewMode}
          onChange={setReviewMode}
          options={[
            { value: "working", label: "Working tree" },
            { value: "branch", label: "Branch vs base" },
          ]}
        />
      </Field>
    </div>
  );
}

function GitPanel() {
  const [baseBranchPrecedence, setBase] = useSetting("baseBranchPrecedence");
  const [protectedBranches, setProtected] = useSetting("protectedBranches");
  const [scanDepth, setScanDepth] = useSetting("scanDepth");
  const [pruneDirs, setPruneDirs] = useSetting("pruneDirs");
  const [watchDebounceMs, setWatchDebounce] = useSetting("watchDebounceMs");
  const [mergeStrategy, setMergeStrategy] = useSetting("mergeStrategy");

  return (
    <div>
      <PanelTitle>Git &amp; Repos</PanelTitle>
      <Field
        label="Base-branch precedence"
        hint="Comma-separated; tried in order for branch-vs-base reviews."
      >
        <TextField value={baseBranchPrecedence} onChange={setBase} wide />
      </Field>
      <Field
        label="Protected branches"
        hint="Never reported or deleted by branch cleanup."
      >
        <TextField value={protectedBranches} onChange={setProtected} wide />
      </Field>
      <Divider />
      <Field label="Folder discovery depth">
        <NumberField
          value={scanDepth}
          onChange={setScanDepth}
          min={1}
          max={20}
          suffix="levels"
        />
      </Field>
      <Field
        label="Discovery prune list"
        hint="Directory names skipped while scanning for repos."
      >
        <TextField value={pruneDirs} onChange={setPruneDirs} wide />
      </Field>
      <Divider />
      <Field
        label="File watcher debounce"
        hint="Applied at startup — restart to take effect."
      >
        <NumberField
          value={watchDebounceMs}
          onChange={setWatchDebounce}
          min={50}
          max={5000}
          step={50}
          suffix="ms"
        />
      </Field>
      <Field label="Default merge strategy">
        <Segmented
          value={mergeStrategy}
          onChange={setMergeStrategy}
          options={[
            { value: "merge", label: "Merge" },
            { value: "squash", label: "Squash" },
            { value: "rebase", label: "Rebase" },
          ]}
        />
      </Field>
    </div>
  );
}

function TerminalPanel() {
  const [terminalShell, setShell] = useSetting("terminalShell");
  const [terminalFontSize, setFontSize] = useSetting("terminalFontSize");
  const [terminalFontFamily, setFontFamily] = useSetting("terminalFontFamily");
  const [terminalCursorBlink, setCursorBlink] = useSetting("terminalCursorBlink");
  const [terminalScrollback, setScrollback] = useSetting("terminalScrollback");

  return (
    <div>
      <PanelTitle>Terminal</PanelTitle>
      <Field
        label="Shell override"
        hint="Blank uses your login shell. Applies to new terminals."
      >
        <TextField
          value={terminalShell}
          onChange={setShell}
          placeholder="/bin/zsh"
          wide
        />
      </Field>
      <Divider />
      <Field label="Font size">
        <NumberField
          value={terminalFontSize}
          onChange={setFontSize}
          min={8}
          max={32}
          suffix="px"
        />
      </Field>
      <Field label="Font family" hint="Blank uses the built-in monospace stack.">
        <TextField
          value={terminalFontFamily}
          onChange={setFontFamily}
          placeholder="e.g. Cascadia Code"
        />
      </Field>
      <Divider />
      <Field label="Cursor blink">
        <Toggle checked={terminalCursorBlink} onChange={setCursorBlink} />
      </Field>
      <Field label="Scrollback" hint="Lines kept per terminal (new terminals).">
        <NumberField
          value={terminalScrollback}
          onChange={setScrollback}
          min={100}
          max={100000}
          step={100}
          suffix="lines"
        />
      </Field>
    </div>
  );
}

// ---- Reset ----------------------------------------------------------------

function ResetButton() {
  const reset = useSettings((s) => s.reset);
  const setPreference = useTheme((s) => s.setPreference);

  const onReset = () => {
    const alsoLayouts = window.confirm(
      "Reset all settings to their defaults?\n\nClick OK to also reset saved panel layouts (reloads the window).",
    );
    void reset();
    setPreference("system");
    if (alsoLayouts) {
      for (const key of Object.keys(localStorage)) {
        if (key.includes("gamut.layout")) localStorage.removeItem(key);
      }
      location.reload();
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      className="w-full justify-start text-[var(--color-muted-foreground)]"
      onClick={onReset}
    >
      <RotateCcw />
      Reset to defaults
    </Button>
  );
}
