import { create } from "zustand";

import { ipc } from "@/lib/ipc";
import { isLinux } from "@/lib/shortcuts";

/**
 * Unified, DB-backed user preferences (issue #29).
 *
 * The source of truth is the backend `settings` table (`pref.`-namespaced keys,
 * read/written via the generic Tauri commands). To avoid a flash of default
 * values on launch — settings load over async IPC — the store also keeps a
 * synchronous `localStorage` mirror that hydrates initial state instantly; the
 * DB then reconciles it on `load()`. Writes update state, the mirror, and the DB.
 *
 * Theme lives in `lib/theme.ts` instead: it must be applied before React renders
 * to avoid a flash, so it keeps its own pre-paint path. The Settings panel still
 * renders the theme control there for a single unified surface.
 */
export interface Settings {
  // Appearance
  editorFontSize: number;
  editorFontFamily: string; // "" → Monaco default
  editorWordWrap: boolean; // wrap long lines in the file editor, diff editors, and blame view
  terminalFontSize: number;
  terminalFontFamily: string; // "" → built-in mono stack
  terminalCursorBlink: boolean;
  toastTimeout: number; // ms
  markdownPreviewByDefault: boolean; // open .md files in rendered preview, not source
  htmlPreviewByDefault: boolean; // open .html/.htm files in the sandboxed preview, not source

  // Diff & Review
  diffLayout: "side-by-side" | "unified";
  reviewMode: "working" | "branch"; // persisted default

  // Git / Repos
  baseBranchPrecedence: string; // comma-separated
  protectedBranches: string; // comma-separated
  scanDepth: number;
  pruneDirs: string; // comma-separated
  watchDebounceMs: number; // applied at startup
  mergeStrategy: "merge" | "squash" | "rebase";
  // After merging a PR, check out its base branch and delete the merged local
  // branch (only when the remote head branch was auto-deleted). See #132.
  autoCleanupAfterMerge: boolean;
  autoFetch: boolean; // periodically fetch repos in the background
  autoFetchIntervalMinutes: number; // minutes between background fetches
  // Show the synced-root folder entry for folder-bound groups in the sidebar.
  // Off → hide it (its discovered subfolders/repos still show); the root stays
  // registered so it can reappear when re-enabled.
  showSyncedRoot: boolean;

  // Terminal
  terminalShell: string; // "" → system login shell
  terminalScrollback: number;
  // Where ⌘/Ctrl+T opens a new terminal when no repo is selected in the active
  // group. A selected repo always wins; this picks the fallback (#154).
  terminalNewTabDir: "group" | "first"; // group's bound folder, or first repo
  // Reopen the terminal layout (tabs/splits/cwds) on launch, respawning a fresh
  // shell per pane at its saved directory (#155). Off → start with a clean slate.
  terminalRestoreSessions: boolean;
  // Render terminals with xterm's WebGL (GPU) renderer (#211). The DOM renderer
  // is the fallback. Defaults on for macOS/Windows (where WKWebView/WebView2
  // handle WebGL cleanly) but off on Linux, whose WebKitGTK + GPU-driver combos
  // can leave stale cells (e.g. a deleted last character lingering on screen) or
  // feel laggier than the DOM renderer. Applies to new terminals (restart a pane
  // to switch it).
  terminalGpuRenderer: boolean;

  // Terminal notifications (background-pane bell / process-exit; see #28)
  terminalNotifySound: boolean; // master on/off for the audible cue
  terminalNotifyOnExit: boolean; // notify when a background shell exits
  terminalNotifyOnBell: boolean; // notify on a background terminal bell (\a)
  terminalNotifySoundName: TerminalSound; // which sound to play ("custom" → file)
  terminalNotifySoundCustom: string; // absolute path to a user-chosen sound file
  terminalNotifyDesktop: boolean; // also show a native OS notification
  terminalNotifyAlways: boolean; // notify even when the event pane is focused

  // Updates
  updateChannel: "stable" | "nightly";

  // Command palette — comma-separated order of the result categories the palette
  // renders (see PALETTE_CATEGORIES). The "Needs attention" section (#84) always
  // sits above these regardless of order. Parsed via `parsePaletteOrder`.
  paletteCategoryOrder: string;

  // Keyboard — JSON map of per-command binding overrides (see lib/shortcuts.ts).
  // "" means no overrides (every command uses its default).
  keybindings: string;

  // GitHub (incl. GitHub Enterprise Server)
  githubApiBase: string; // "" → https://api.github.com
  githubGraphqlBase: string; // "" → https://api.github.com/graphql
  githubPrPageSize: number; // open PRs fetched per repo
}

/**
 * Notification sound choices. The first five are synthesized in the browser
 * (see `features/terminal/notify.ts`) so v1 ships no bundled audio assets;
 * `"custom"` plays a user-supplied file (`terminalNotifySoundCustom`). The list
 * doubles as the enum guard for the `terminalNotifySoundName` setting.
 */
export const TERMINAL_SOUNDS = ["chime", "ping", "blip", "knock", "alert", "custom"] as const;
export type TerminalSound = (typeof TERMINAL_SOUNDS)[number];

/**
 * Reorderable command-palette result categories (issue #86). "repos" covers the
 * Repos/Recent block; the order here is the order the palette renders them in.
 * The list doubles as the source of truth for the default and for validation.
 */
export const PALETTE_CATEGORIES = ["repos", "groups", "terminals"] as const;
export type PaletteCategory = (typeof PALETTE_CATEGORIES)[number];

/**
 * Parse the `paletteCategoryOrder` setting into a complete, de-duplicated order.
 * Unknown/duplicate tokens are dropped and any categories missing from the
 * stored value are appended in their canonical order, so the result is always a
 * full permutation of `PALETTE_CATEGORIES` even if the stored string is corrupt.
 */
export function parsePaletteOrder(raw: string): PaletteCategory[] {
  const valid = new Set<string>(PALETTE_CATEGORIES);
  const seen = new Set<PaletteCategory>();
  const out: PaletteCategory[] = [];
  for (const token of raw.split(",").map((s) => s.trim())) {
    if (valid.has(token) && !seen.has(token as PaletteCategory)) {
      seen.add(token as PaletteCategory);
      out.push(token as PaletteCategory);
    }
  }
  for (const c of PALETTE_CATEGORIES) if (!seen.has(c)) out.push(c);
  return out;
}

export const DEFAULTS: Settings = {
  editorFontSize: 12,
  editorFontFamily: "",
  // Off → long lines scroll horizontally (historical behaviour). On → Monaco
  // wraps at the viewport edge, and the blame view wraps too.
  editorWordWrap: false,
  terminalFontSize: 13,
  terminalFontFamily: "",
  // Off by default: a blinking cursor repaints every pane ~2x/sec even when
  // fully idle, which adds up across many open terminals. See #208.
  terminalCursorBlink: false,
  toastTimeout: 6000,
  // Off → markdown opens in the editable source; the Files view's Edit/Preview
  // toggle still works per-file regardless.
  markdownPreviewByDefault: false,
  // Off → HTML opens in the editable source. Separate from the markdown
  // preference on purpose: the two file types are previewed by different
  // renderers, and one switch labelled for markdown silently governing HTML too
  // would make that label a lie.
  htmlPreviewByDefault: false,

  diffLayout: "side-by-side",
  reviewMode: "working",

  baseBranchPrecedence: "trunk, main, master",
  protectedBranches: "main, master",
  scanDepth: 6,
  pruneDirs: "node_modules, vendor, target, .git, dist, build, .next, .cache",
  watchDebounceMs: 400,
  mergeStrategy: "merge",
  autoCleanupAfterMerge: true,
  autoFetch: true,
  // 15 min, not 5: across a large fleet, remote-tracking refs rarely need
  // sub-15-minute freshness, and a longer interval means the background fetch
  // burst runs far less often — much cheaper on battery (#274).
  autoFetchIntervalMinutes: 15,
  showSyncedRoot: true,

  terminalShell: "",
  terminalScrollback: 5000,
  // Default to the first repo; users who work mostly from a group's bound folder
  // can switch the fallback to the group folder.
  terminalNewTabDir: "first",
  // On by default: reopening yesterday's terminal layout is the point of the
  // feature; opt out for a clean slate each launch.
  terminalRestoreSessions: true,
  // On for macOS/Windows (preserves #211), off on Linux where the WebKitGTK
  // WebGL path renders stale cells / lags on some GPU drivers. Users can flip
  // it either way; this is only the default.
  terminalGpuRenderer: !isLinux(),

  // Sound on by default for both discrete events; desktop notifications stay
  // off until the user opts in (they require an OS permission grant).
  terminalNotifySound: true,
  terminalNotifyOnExit: true,
  terminalNotifyOnBell: true,
  terminalNotifySoundName: "chime",
  terminalNotifySoundCustom: "",
  terminalNotifyDesktop: false,
  // Off by default: only notify for backgrounded panes / when the app window is
  // unfocused. Opt in to also be cued while looking right at the active pane.
  terminalNotifyAlways: false,

  // Updates
  updateChannel: "stable",

  // Default preserves the historical render order (Repos/Recent → Groups → Terminals).
  paletteCategoryOrder: PALETTE_CATEGORIES.join(","),

  keybindings: "",

  githubApiBase: "",
  githubGraphqlBase: "",
  githubPrPageSize: 50,
};

type Key = keyof Settings;

/** Allowed values for enum-typed keys, used to reject corrupt stored strings. */
const ENUMS: Partial<Record<Key, readonly string[]>> = {
  diffLayout: ["side-by-side", "unified"],
  terminalNotifySoundName: TERMINAL_SOUNDS,
  reviewMode: ["working", "branch"],
  mergeStrategy: ["merge", "squash", "rebase"],
  updateChannel: ["stable", "nightly"],
  terminalNewTabDir: ["group", "first"],
};

/** localStorage mirror of the DB, for synchronous hydration before IPC loads. */
const MIRROR_KEY = "gamut.settings";
/** Backend key for a preference (matches the `pref.` namespace on the Rust side). */
const dbKey = (key: Key) => `pref.${key}`;

function deserialize<K extends Key>(key: K, raw: string): Settings[K] {
  const def = DEFAULTS[key];
  if (typeof def === "number") {
    const n = Number(raw);
    return (Number.isFinite(n) ? n : def) as Settings[K];
  }
  if (typeof def === "boolean") {
    return (raw === "1" || raw === "true") as Settings[K];
  }
  // Enum-typed keys: fall back to the default if the stored value is unknown,
  // so a corrupt DB/mirror can't put the store into an invalid state.
  const allowed = ENUMS[key];
  if (allowed && !allowed.includes(raw)) return def;
  return raw as Settings[K];
}

function serialize<K extends Key>(key: K, value: Settings[K]): string {
  if (typeof DEFAULTS[key] === "boolean") return value ? "1" : "0";
  return String(value);
}

function readMirror(): Record<string, string> {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeMirror(mirror: Record<string, string>) {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(mirror));
  } catch {
    // Ignore quota / unavailable storage — the DB remains the source of truth.
  }
}

/** Build a typed `Settings` from a raw string map, falling back to defaults. */
function fromRaw(raw: Record<string, string>): Settings {
  const values = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as Key[]) {
    // Mirror stores plain keys; the DB returns `pref.`-prefixed keys.
    const v = raw[key] ?? raw[dbKey(key)];
    if (v != null) (values as Record<string, unknown>)[key] = deserialize(key, v);
  }
  return values;
}

function hydrate(): Settings {
  return fromRaw(readMirror());
}

interface SettingsState {
  values: Settings;
  /** True once the DB has been read at least once. */
  loaded: boolean;
  /** Read all preferences from the DB and reconcile (DB wins). */
  load: () => Promise<void>;
  /** Persist a single preference (state + mirror + DB). */
  set: <K extends Key>(key: K, value: Settings[K]) => void;
  /** Clear all preferences back to defaults (state + mirror + DB). */
  reset: () => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  values: hydrate(),
  loaded: false,
  load: async () => {
    try {
      const raw = await ipc.getSettings();
      const values = fromRaw(raw);
      // Refresh the mirror from the authoritative DB snapshot.
      const mirror: Record<string, string> = {};
      for (const key of Object.keys(DEFAULTS) as Key[]) {
        mirror[key] = serialize(key, values[key]);
      }
      writeMirror(mirror);
      set({ values, loaded: true });
    } catch {
      // Backend unavailable — keep the mirror-hydrated values.
      set({ loaded: true });
    }
  },
  set: (key, value) => {
    const values = { ...get().values, [key]: value };
    const mirror = readMirror();
    mirror[key] = serialize(key, value);
    writeMirror(mirror);
    set({ values });
    ipc.setSetting(dbKey(key), serialize(key, value)).catch(() => {});
  },
  reset: async () => {
    writeMirror({});
    set({ values: { ...DEFAULTS } });
    try {
      await ipc.resetSettings();
    } catch {
      // Ignore — local state already reflects defaults.
    }
  },
}));

/** Read the current toast timeout from outside React (toast store helper). */
export const toastTimeout = () => useSettings.getState().values.toastTimeout;

/** Monaco option fragment for a plain code editor (font size + family + word wrap). */
export function useEditorPrefs() {
  const fontSize = useSettings((s) => s.values.editorFontSize);
  const fontFamily = useSettings((s) => s.values.editorFontFamily);
  const wordWrap = useSettings((s) => s.values.editorWordWrap);
  return {
    fontSize,
    fontFamily: fontFamily || undefined,
    wordWrap: (wordWrap ? "on" : "off") as "on" | "off",
  };
}

/** Monaco option fragment for a diff editor (layout + font size + family + word wrap). */
export function useDiffEditorPrefs() {
  const layout = useSettings((s) => s.values.diffLayout);
  const { fontSize, fontFamily, wordWrap } = useEditorPrefs();
  return {
    renderSideBySide: layout === "side-by-side",
    // Honour the chosen layout even in a narrow pane: Monaco otherwise silently
    // collapses side-by-side to inline below `renderSideBySideInlineBreakpoint`
    // (900px), which the review pane's file-list sidebar routinely puts it under
    // — making the "Side by side" toggle look broken. Inert when unified.
    useInlineViewWhenSpaceIsLimited: false,
    fontSize,
    fontFamily,
    wordWrap,
  };
}
