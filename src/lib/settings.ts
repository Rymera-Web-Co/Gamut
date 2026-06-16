import { create } from "zustand";

import { ipc } from "@/lib/ipc";

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
  terminalFontSize: number;
  terminalFontFamily: string; // "" → built-in mono stack
  terminalCursorBlink: boolean;
  toastTimeout: number; // ms

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

  // Terminal
  terminalShell: string; // "" → system login shell
  terminalScrollback: number;
}

export const DEFAULTS: Settings = {
  editorFontSize: 12,
  editorFontFamily: "",
  terminalFontSize: 13,
  terminalFontFamily: "",
  terminalCursorBlink: true,
  toastTimeout: 6000,

  diffLayout: "side-by-side",
  reviewMode: "working",

  baseBranchPrecedence: "trunk, main, master",
  protectedBranches: "main, master",
  scanDepth: 6,
  pruneDirs: "node_modules, vendor, target, .git, dist, build, .next, .cache",
  watchDebounceMs: 400,
  mergeStrategy: "merge",

  terminalShell: "",
  terminalScrollback: 5000,
};

type Key = keyof Settings;

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

/** Monaco option fragment for a plain code editor (font size + family). */
export function useEditorPrefs() {
  const fontSize = useSettings((s) => s.values.editorFontSize);
  const fontFamily = useSettings((s) => s.values.editorFontFamily);
  return { fontSize, fontFamily: fontFamily || undefined };
}

/** Monaco option fragment for a diff editor (layout + font size + family). */
export function useDiffEditorPrefs() {
  const layout = useSettings((s) => s.values.diffLayout);
  const { fontSize, fontFamily } = useEditorPrefs();
  return { renderSideBySide: layout === "side-by-side", fontSize, fontFamily };
}
