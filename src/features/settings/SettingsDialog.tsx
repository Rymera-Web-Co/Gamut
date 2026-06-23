import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  Bell,
  ChevronDown,
  ChevronUp,
  Command,
  Copy,
  Download,
  FolderOpen,
  GitCompare,
  GitFork,
  Github,
  Info,
  Keyboard,
  Loader2,
  LogOut,
  Monitor,
  Moon,
  Palette,
  Play,
  RotateCcw,
  SquareTerminal,
  Sun,
} from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { copy } from "@/lib/clipboard";
import { ipc, pickAudioFile, pickSavePath, type Diagnostics } from "@/lib/ipc";
import { toast } from "@/store/toast";
import {
  parsePaletteOrder,
  PALETTE_CATEGORIES,
  useSettings,
  type PaletteCategory,
  type Settings,
  type TerminalSound,
} from "@/lib/settings";
import {
  bindingFromEvent,
  findConflicts,
  formatBinding,
  isMac,
  isModifierCode,
  parseOverrides,
  resolveBindings,
  SHORTCUTS,
  type Binding,
  type ShortcutId,
} from "@/lib/shortcuts";
import { useGithubAuth, useLogout } from "@/features/review/api";
import { useTheme, type ThemePreference } from "@/lib/theme";
import { useUpdater } from "@/lib/updater";
import { useUiStore } from "@/store/ui";
import { BUILTIN_SOUNDS, ensureDesktopPermission, playSound } from "@/features/terminal/notify";

const CATEGORIES = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "diff", label: "Diff & Review", icon: GitCompare },
  { id: "git", label: "Git & Repos", icon: GitFork },
  { id: "github", label: "GitHub", icon: Github },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "palette", label: "Command palette", icon: Command },
  { id: "keyboard", label: "Keyboard", icon: Keyboard },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
  { id: "about", label: "About", icon: Info },
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
          {category === "github" && <GitHubPanel />}
          {category === "terminal" && <TerminalPanel />}
          {category === "palette" && <CommandPalettePanel />}
          {category === "keyboard" && <KeyboardPanel />}
          {category === "notifications" && <NotificationsPanel />}
          {category === "diagnostics" && <DiagnosticsPanel />}
          {category === "about" && <AboutPanel />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- Layout primitives ----------------------------------------------------

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
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

function PanelTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-1 text-base font-semibold">{children}</h2>;
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

function Toggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
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

function Select<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="h-8 w-48 rounded-md border bg-[var(--color-background)] px-2 text-sm"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
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
  const [markdownPreviewByDefault, setMarkdownPreviewByDefault] = useSetting(
    "markdownPreviewByDefault",
  );
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
      <Field label="Editor font family" hint="Leave blank for the editor default.">
        <TextField
          value={editorFontFamily}
          onChange={setEditorFontFamily}
          placeholder="e.g. JetBrains Mono"
        />
      </Field>
      <Field
        label="Open markdown in preview"
        hint="Show .md files rendered by default. The Edit/Preview toggle still switches per file."
      >
        <Toggle checked={markdownPreviewByDefault} onChange={setMarkdownPreviewByDefault} />
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
      <Field label="Default review mode" hint="Which view a repository's Review tab opens in.">
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
  const [autoCleanupAfterMerge, setAutoCleanup] = useSetting("autoCleanupAfterMerge");
  const [autoFetch, setAutoFetch] = useSetting("autoFetch");
  const [autoFetchInterval, setAutoFetchInterval] = useSetting("autoFetchIntervalMinutes");

  return (
    <div>
      <PanelTitle>Git &amp; Repos</PanelTitle>
      <Field
        label="Base-branch precedence"
        hint="Comma-separated; tried in order for branch-vs-base reviews."
      >
        <TextField value={baseBranchPrecedence} onChange={setBase} wide />
      </Field>
      <Field label="Protected branches" hint="Never reported or deleted by branch cleanup.">
        <TextField value={protectedBranches} onChange={setProtected} wide />
      </Field>
      <Divider />
      <Field label="Folder discovery depth">
        <NumberField value={scanDepth} onChange={setScanDepth} min={1} max={20} suffix="levels" />
      </Field>
      <Field label="Discovery prune list" hint="Directory names skipped while scanning for repos.">
        <TextField value={pruneDirs} onChange={setPruneDirs} wide />
      </Field>
      <Divider />
      <Field label="File watcher debounce" hint="Applied at startup — restart to take effect.">
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
      <Field
        label="Clean up after merging a PR"
        hint="After merging, check out the base branch and delete the merged local branch (only when its remote branch was auto-deleted). Protected branches are never deleted."
      >
        <Toggle checked={autoCleanupAfterMerge} onChange={setAutoCleanup} />
      </Field>
      <Divider />
      <Field
        label="Auto-fetch repositories"
        hint="Periodically fetch all repos in the background so ahead/behind counts and branches stay current."
      >
        <Toggle checked={autoFetch} onChange={setAutoFetch} />
      </Field>
      {autoFetch && (
        <Field label="Auto-fetch interval">
          <NumberField
            value={autoFetchInterval}
            onChange={setAutoFetchInterval}
            min={1}
            max={120}
            suffix="min"
          />
        </Field>
      )}
    </div>
  );
}

function TerminalPanel() {
  const [terminalShell, setShell] = useSetting("terminalShell");
  const [terminalFontSize, setFontSize] = useSetting("terminalFontSize");
  const [terminalFontFamily, setFontFamily] = useSetting("terminalFontFamily");
  const [terminalCursorBlink, setCursorBlink] = useSetting("terminalCursorBlink");
  const [terminalScrollback, setScrollback] = useSetting("terminalScrollback");
  const [restoreSessions, setRestoreSessions] = useSetting("terminalRestoreSessions");

  return (
    <div>
      <PanelTitle>Terminal</PanelTitle>
      <Field label="Shell override" hint="Blank uses your login shell. Applies to new terminals.">
        <TextField value={terminalShell} onChange={setShell} placeholder="/bin/zsh" wide />
      </Field>
      <Divider />
      <Field label="Font size">
        <NumberField value={terminalFontSize} onChange={setFontSize} min={8} max={32} suffix="px" />
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
      <Divider />
      <Field
        label="Restore sessions on launch"
        hint="Reopen your terminal tabs and splits, respawning a fresh shell in each saved directory. Scrollback and running processes aren't restored."
      >
        <Toggle checked={restoreSessions} onChange={setRestoreSessions} />
      </Field>
    </div>
  );
}

function GitHubPanel() {
  const [apiBase, setApiBase] = useSetting("githubApiBase");
  const [graphqlBase, setGraphqlBase] = useSetting("githubGraphqlBase");
  const [prPageSize, setPrPageSize] = useSetting("githubPrPageSize");
  const auth = useGithubAuth();
  const logout = useLogout();
  const [checking, setChecking] = useState(false);

  const connected = auth.data?.logged_in ?? false;

  const testConnection = async () => {
    setChecking(true);
    try {
      const status = await ipc.githubCheck();
      auth.refetch();
      toast.success(`Connected as ${status.login} ✓`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div>
      <PanelTitle>GitHub</PanelTitle>
      <p className="mb-2 text-xs text-[var(--color-muted-foreground)]">
        Point Gamut at a GitHub Enterprise Server by overriding the API and GraphQL endpoints. Leave
        blank to use github.com. Sign in from the GitHub button in the sidebar; on Enterprise, use a
        personal-access token.
      </p>

      <Field label="Account">
        {connected ? (
          <div className="flex items-center gap-2">
            <span className="text-sm">
              Signed in as <span className="font-medium">{auth.data?.login}</span>
            </span>
            <Button variant="outline" size="sm" className="h-8" onClick={() => logout.mutate()}>
              <LogOut className="size-3.5" />
              Sign out
            </Button>
          </div>
        ) : (
          <span className="text-sm text-[var(--color-muted-foreground)]">Not connected</span>
        )}
      </Field>
      <Divider />
      <Field label="API base URL" hint="REST endpoint. e.g. https://ghe.example.com/api/v3">
        <TextField
          value={apiBase}
          onChange={setApiBase}
          placeholder="https://api.github.com"
          wide
        />
      </Field>
      <Field label="GraphQL endpoint" hint="e.g. https://ghe.example.com/api/graphql">
        <TextField
          value={graphqlBase}
          onChange={setGraphqlBase}
          placeholder="https://api.github.com/graphql"
          wide
        />
      </Field>
      <Field label="Verify" hint="Check the stored token reaches the configured host.">
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          disabled={!connected || checking}
          onClick={() => void testConnection()}
        >
          {checking ? <Loader2 className="animate-spin" /> : null}
          Test connection
        </Button>
      </Field>
      <Divider />
      <Field label="PR list page size" hint="Open pull requests fetched per repository (1–100).">
        <NumberField value={prPageSize} onChange={setPrPageSize} min={1} max={100} suffix="PRs" />
      </Field>
    </div>
  );
}

const PALETTE_CATEGORY_LABELS: Record<PaletteCategory, string> = {
  repos: "Repositories",
  groups: "Groups",
  terminals: "Terminals",
};

function CommandPalettePanel() {
  const [paletteCategoryOrder, setOrder] = useSetting("paletteCategoryOrder");
  const order = parsePaletteOrder(paletteCategoryOrder);
  const isDefault = order.join(",") === PALETTE_CATEGORIES.join(",");

  // Swap a category with its neighbour, persisting the canonical comma-joined
  // string (re-parsed on read, so a corrupt stored value can never stick).
  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next.join(","));
  };

  return (
    <div>
      <PanelTitle>Command palette</PanelTitle>
      <p className="mb-3 text-xs text-[var(--color-muted-foreground)]">
        Order the result categories shown in the ⌘/Ctrl+K palette. The first category renders first,
        so its top result is pre-selected when the palette opens. Terminals or groups needing
        attention are always pinned above these.
      </p>
      <div className="rounded-md border">
        {order.map((cat, i) => (
          <div
            key={cat}
            className="flex items-center justify-between gap-4 border-b px-3 py-2 last:border-b-0"
          >
            <span className="text-sm">{PALETTE_CATEGORY_LABELS[cat]}</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => move(i, -1)}
                disabled={i === 0}
                title="Move up"
                className="flex size-7 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)] disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronUp className="size-4" />
              </button>
              <button
                onClick={() => move(i, 1)}
                disabled={i === order.length - 1}
                title="Move down"
                className="flex size-7 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)] disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronDown className="size-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-[var(--color-muted-foreground)]"
          disabled={isDefault}
          onClick={() => setOrder(PALETTE_CATEGORIES.join(","))}
        >
          <RotateCcw className="size-3.5" />
          Reset order
        </Button>
      </div>
    </div>
  );
}

/** A button that captures the next key combo to rebind a shortcut. */
function BindingButton({
  binding,
  conflict,
  onCapture,
}: {
  binding: Binding;
  conflict: boolean;
  onCapture: (binding: Binding) => void;
}) {
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!capturing) return;
    const handler = (e: KeyboardEvent) => {
      // Swallow the keystroke (capture phase) so the global shortcut listener
      // and any focused control don't act on it while we're recording.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(false);
        return;
      }
      // Wait for a non-modifier key to complete the combo.
      if (isModifierCode(e.code)) return;
      onCapture(bindingFromEvent(e));
      setCapturing(false);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [capturing, onCapture]);

  return (
    <button
      onClick={() => setCapturing((c) => !c)}
      className={cn(
        "min-w-24 rounded-md border px-2.5 py-1 font-mono text-xs transition-colors",
        capturing
          ? "border-[var(--color-primary)] text-[var(--color-primary)]"
          : "hover:bg-[var(--color-accent)]",
        conflict &&
          !capturing &&
          "border-[var(--color-destructive)] text-[var(--color-destructive)]",
      )}
      title={capturing ? "Press a key combination, or Esc to cancel" : "Click to rebind"}
    >
      {capturing ? "Press keys…" : formatBinding(binding)}
    </button>
  );
}

function KeyboardPanel() {
  const [keybindings, setKeybindings] = useSetting("keybindings");
  const mac = isMac();

  const overrides = parseOverrides(keybindings);
  const resolved = resolveBindings(overrides);
  const conflicts = findConflicts(resolved);

  const setBinding = (id: ShortcutId, binding: Binding) => {
    setKeybindings(JSON.stringify({ ...overrides, [id]: binding }));
  };
  const resetBinding = (id: ShortcutId) => {
    const next = { ...overrides };
    delete next[id];
    setKeybindings(Object.keys(next).length ? JSON.stringify(next) : "");
  };

  // Group commands by their category for display, preserving definition order.
  const categories = SHORTCUTS.reduce<Record<string, typeof SHORTCUTS>>((acc, def) => {
    (acc[def.category] ??= []).push(def);
    return acc;
  }, {});

  return (
    <div>
      <PanelTitle>Keyboard</PanelTitle>
      <p className="mb-2 text-xs text-[var(--color-muted-foreground)]">
        Click a shortcut to rebind it; press the new combination, or Esc to cancel. Conflicting
        bindings are flagged in red.
        {mac ? " ⌘ is the primary modifier." : " Ctrl is the primary modifier."}
      </p>
      <div className="mb-2 flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-[var(--color-muted-foreground)]"
          disabled={!keybindings}
          onClick={() => setKeybindings("")}
        >
          <RotateCcw className="size-3.5" />
          Reset all shortcuts
        </Button>
      </div>

      {Object.entries(categories).map(([cat, defs]) => (
        <div key={cat}>
          <div className="mb-1 mt-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
            {cat}
          </div>
          {defs.map((def) => {
            const overridden = overrides[def.id] != null;
            const conflict = conflicts[def.id];
            return (
              <div
                key={def.id}
                className="flex items-center justify-between gap-4 border-b py-2 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="text-sm">{def.label}</div>
                  {conflict && (
                    <div className="mt-0.5 text-xs text-[var(--color-destructive)]">
                      Conflicts with{" "}
                      {conflict.map((id) => SHORTCUTS.find((s) => s.id === id)?.label).join(", ")}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <BindingButton
                    binding={resolved[def.id]}
                    conflict={!!conflict}
                    onCapture={(b) => setBinding(def.id, b)}
                  />
                  {overridden && (
                    <button
                      onClick={() => resetBinding(def.id)}
                      title="Reset to default"
                      className="flex size-6 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
                    >
                      <RotateCcw className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function NotificationsPanel() {
  const [sound, setSound] = useSetting("terminalNotifySound");
  const [onExit, setOnExit] = useSetting("terminalNotifyOnExit");
  const [onBell, setOnBell] = useSetting("terminalNotifyOnBell");
  const [soundName, setSoundName] = useSetting("terminalNotifySoundName");
  const [customPath, setCustomPath] = useSetting("terminalNotifySoundCustom");
  const [desktop, setDesktop] = useSetting("terminalNotifyDesktop");
  const [always, setAlways] = useSetting("terminalNotifyAlways");

  const chooseCustom = async () => {
    const path = await pickAudioFile();
    if (path) {
      setCustomPath(path);
      setSoundName("custom");
    }
  };

  const onSelectSound = (v: TerminalSound) => {
    setSoundName(v);
    // Selecting "Custom…" with nothing chosen yet opens the picker straight away.
    if (v === "custom" && !customPath) void chooseCustom();
  };

  const customName = customPath.split(/[\\/]/).pop() || customPath;

  const toggleDesktop = (next: boolean) => {
    // Prompt for OS permission the moment the user opts in, rather than on the
    // first background event. Leave the preference on regardless — the send
    // path re-checks, so a later grant in System Settings just starts working.
    if (next) void ensureDesktopPermission();
    setDesktop(next);
  };

  return (
    <div>
      <PanelTitle>Notifications</PanelTitle>
      <p className="mb-2 text-xs text-[var(--color-muted-foreground)]">
        Alerts for terminal events — a process exiting or a bell (e.g. Claude Code finishing a task
        or asking for input). These fire for background panes and whenever the Gamut window is
        unfocused; the focused pane stays silent while you're looking at it unless you enable
        "Notify even when focused" below.
      </p>
      <Field
        label="Play sound on terminal events"
        hint="An audible cue when a background pane signals an event."
      >
        <Toggle checked={sound} onChange={setSound} />
      </Field>
      <Divider />
      <Field label="Notify on process exit" hint="A background shell process ends.">
        <Toggle checked={onExit} onChange={setOnExit} />
      </Field>
      <Field label="Notify on terminal bell" hint="A pane rings the bell (\a).">
        <Toggle checked={onBell} onChange={setOnBell} />
      </Field>
      <Field
        label="Notify even when focused"
        hint="Cue events for the active pane too, not just background panes or an unfocused window."
      >
        <Toggle checked={always} onChange={setAlways} />
      </Field>
      <Divider />
      <Field label="Sound" hint="Plays for the events selected above.">
        <div className="flex items-center gap-2">
          <Select
            value={soundName}
            onChange={onSelectSound}
            options={[
              ...BUILTIN_SOUNDS.map((s) => ({ value: s.id, label: s.label })),
              { value: "custom" as TerminalSound, label: "Custom…" },
            ]}
          />
          <Button variant="outline" size="sm" className="h-8" onClick={() => playSound(soundName)}>
            <Play className="size-3.5" />
            Test
          </Button>
        </div>
      </Field>
      {soundName === "custom" && (
        <Field
          label="Custom sound file"
          hint={customPath ? customName : "Pick a .wav, .mp3, .ogg, .m4a, .aac or .flac file."}
        >
          <Button variant="outline" size="sm" className="h-8" onClick={chooseCustom}>
            <FolderOpen className="size-3.5" />
            {customPath ? "Change…" : "Choose file…"}
          </Button>
        </Field>
      )}
      <Divider />
      <Field
        label="Show desktop notification"
        hint="Also post a native OS notification. Needs notification permission; respects Do Not Disturb."
      >
        <Toggle checked={desktop} onChange={toggleDesktop} />
      </Field>
    </div>
  );
}

// ---- Diagnostics ----------------------------------------------------------

function DiagnosticsPanel() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = () => {
    setLoading(true);
    ipc
      .diagnostics()
      .then(setData)
      .catch(() => toast.error("Could not load diagnostics"))
      .finally(() => setLoading(false));
  };

  // Load whenever the panel mounts (i.e. the category is opened).
  useEffect(refresh, []);

  const onCopy = async () => {
    const snapshot = await ipc.diagnostics().catch(() => null);
    if (!snapshot) return toast.error("Could not load diagnostics");
    await copy(JSON.stringify(snapshot, null, 2), "Diagnostics copied to clipboard");
  };

  const onSave = async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const path = await pickSavePath(`gamut-diagnostics-${stamp}.json`);
    if (!path) return;
    try {
      await ipc.diagnosticsWrite(path);
      toast.success("Diagnostics saved");
    } catch (e) {
      toast.error(String(e));
    }
  };

  const stalls = data?.op_stats.find((s) => s.op === "ui_stall");

  return (
    <div>
      <PanelTitle>Diagnostics</PanelTitle>
      <p className="mb-2 text-xs text-[var(--color-muted-foreground)]">
        Timing for the heavy git operations, plus a snapshot of the current setup. If the app
        freezes or feels slow, copy or save this and share it so we can pinpoint what's blocking.
      </p>

      <div className="mb-3 flex gap-2">
        <Button variant="outline" size="sm" className="h-8" onClick={refresh}>
          {loading ? <Loader2 className="animate-spin" /> : <RotateCcw className="size-3.5" />}
          Refresh
        </Button>
        <Button variant="outline" size="sm" className="h-8" onClick={() => void onCopy()}>
          <Copy className="size-3.5" />
          Copy
        </Button>
        <Button variant="outline" size="sm" className="h-8" onClick={() => void onSave()}>
          <Download className="size-3.5" />
          Save…
        </Button>
      </div>

      {data && (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <DiagRow label="Version" value={data.app_version} />
            <DiagRow label="Platform" value={`${data.os} (${data.arch})`} />
            <DiagRow label="Repositories" value={String(data.repo_count)} />
            <DiagRow label="Groups" value={String(data.group_count)} />
            <DiagRow label="Watched paths" value={String(data.watched_path_count)} />
            {stalls && (
              <DiagRow label="UI stalls" value={`${stalls.count} (max ${stalls.max_ms} ms)`} />
            )}
          </div>

          <Divider />
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
            Operation timings (recent)
          </div>
          {data.op_stats.length === 0 ? (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              No operations recorded yet — interact with a repo and refresh.
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[var(--color-muted-foreground)]">
                <tr className="text-left">
                  <th className="py-1 font-medium">Operation</th>
                  <th className="py-1 text-right font-medium">Count</th>
                  <th className="py-1 text-right font-medium">Avg</th>
                  <th className="py-1 text-right font-medium">Max</th>
                  <th className="py-1 text-right font-medium">Fails</th>
                </tr>
              </thead>
              <tbody>
                {data.op_stats.map((s) => (
                  <tr key={s.op} className="border-t">
                    <td className="py-1 font-mono">{s.op}</td>
                    <td className="py-1 text-right tabular-nums">{s.count}</td>
                    <td className="py-1 text-right tabular-nums">{s.avg_ms} ms</td>
                    <td
                      className={cn(
                        "py-1 text-right tabular-nums",
                        s.max_ms >= 1000 && "font-semibold text-[var(--color-destructive)]",
                      )}
                    >
                      {s.max_ms} ms
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {s.fail_count > 0 ? (
                        <span className="text-[var(--color-destructive)]">{s.fail_count}</span>
                      ) : (
                        0
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function DiagRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-0.5">
      <span className="text-[var(--color-muted-foreground)]">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

// ---- About / Updates ------------------------------------------------------

function AboutPanel() {
  const [version, setVersion] = useState<string | null>(null);
  const status = useUpdater((s) => s.status);
  const available = useUpdater((s) => s.version);
  const progress = useUpdater((s) => s.progress);
  const error = useUpdater((s) => s.error);
  const check = useUpdater((s) => s.check);
  const downloadAndInstall = useUpdater((s) => s.downloadAndInstall);
  const restart = useUpdater((s) => s.restart);
  const updateChannel = useSettings((s) => s.values.updateChannel);

  useEffect(() => {
    if (!isTauri()) return;
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  const checking = status === "checking";
  const downloading = status === "downloading";
  const pct = progress == null ? null : Math.round(progress * 100);

  const onChannelChange = (value: Settings["updateChannel"]) => {
    if (value === updateChannel) return;
    // Update the store immediately for responsive UI, but persist straight to
    // the DB and await it: the Rust `check_for_update` command reads
    // `pref.updateChannel` from the DB, so the value must be committed before
    // we re-check, not just queued via the store's fire-and-forget write.
    useSettings.getState().set("updateChannel", value);
    void ipc.setSetting("pref.updateChannel", value).then(() => useUpdater.getState().check());
  };

  return (
    <div>
      <PanelTitle>About</PanelTitle>
      <Field label="Version">
        <span className="text-sm text-[var(--color-muted-foreground)]">{version ?? "—"}</span>
      </Field>
      <Divider />
      <Field
        label="Update channel"
        hint="Stable ships reviewed releases. Nightly tracks the latest build."
      >
        <Segmented<Settings["updateChannel"]>
          value={updateChannel}
          onChange={onChannelChange}
          options={[
            { value: "stable", label: "Stable" },
            { value: "nightly", label: "Nightly" },
          ]}
        />
      </Field>
      {updateChannel === "nightly" && (
        <div className="mt-1 text-xs text-[var(--color-destructive)]">
          Nightly builds are unstable and ship the latest unreviewed code. On macOS they're
          unsigned, so Gatekeeper will warn before you can open them. Opt in only if you want the
          bleeding edge.
        </div>
      )}
      <Divider />
      <Field
        label="Updates"
        hint="Gamut checks for updates on launch. Updates are signed and verified before install."
      >
        {status === "available" ? (
          <Button size="sm" onClick={() => void downloadAndInstall()}>
            Download {available}
          </Button>
        ) : status === "ready" ? (
          <Button size="sm" onClick={() => void restart()}>
            Restart to update
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={checking || downloading}
            onClick={() => void check()}
          >
            {checking ? <Loader2 className="animate-spin" /> : null}
            {checking ? "Checking…" : "Check for updates"}
          </Button>
        )}
      </Field>
      {(downloading || status === "uptodate" || status === "error") && (
        <div className="mt-1 text-xs text-[var(--color-muted-foreground)]">
          {downloading && (pct == null ? "Downloading update…" : `Downloading update… ${pct}%`)}
          {status === "uptodate" && "You're on the latest version."}
          {status === "error" && (
            <span className="text-[var(--color-destructive)]">
              {error ?? "Update check failed."}
            </span>
          )}
        </div>
      )}
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
