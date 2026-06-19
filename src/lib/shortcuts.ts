/**
 * Remappable global shortcuts (issue #34).
 *
 * Every global command has a stable id, a default key binding, and a category
 * for grouping in the Settings → Keyboard panel. Bindings are stored by physical
 * key `code` plus modifier flags, which sidesteps the two long-standing pitfalls
 * of matching on `event.key`: ⌥ (Alt) mangles `key` on macOS, and Caps Lock /
 * Shift change its case. `code` is layout-stable ("KeyK" regardless of either),
 * and Shift is matched explicitly via its own flag.
 *
 * The "primary" modifier (`mod`) is ⌘ on macOS and Ctrl elsewhere — the usual
 * cross-platform convention. `ctrl` is a *literal* Control press, used for the
 * repo-cycle ⌃Tab binding which is Control on every platform.
 *
 * `useKeyboardShortcuts` resolves these (defaults overlaid with the user's saved
 * overrides) and dispatches by matching live keydown events against them.
 */

/** A key combination: a physical key `code` plus the modifiers that must be held. */
export interface Binding {
  /** `KeyboardEvent.code`, e.g. "KeyK", "Digit1", "Backquote", "Comma", "Tab". */
  code: string;
  /** Primary modifier: ⌘ on macOS, Ctrl elsewhere. */
  mod?: boolean;
  /** Literal Control (distinct from `mod`); for ⌃Tab-style bindings. */
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export type ShortcutId =
  | "view.files"
  | "view.history"
  | "view.review"
  | "view.pulls"
  | "toggleSidebar"
  | "repoSearch"
  | "toggleTheme"
  | "commandPalette"
  | "toggleTerminal"
  | "maximizeTerminal"
  | "openSettings"
  | "push"
  | "pull"
  | "fetchGroup"
  | "cycleRepoNext"
  | "cycleRepoPrev";

export interface ShortcutDef {
  id: ShortcutId;
  label: string;
  /** UI grouping in the Keyboard settings panel. */
  category: "View" | "Layout" | "Git" | "Repos";
  defaultBinding: Binding;
  /**
   * Whether the command still fires while the user is typing in an input, the
   * editor, or a terminal. Navigation/layout commands do; git and repo-cycle
   * commands are suppressed so they don't clash with editor/terminal keys.
   */
  whenTyping: boolean;
}

/**
 * The full command set, in display order. Bindings here mirror the previously
 * hardcoded `useKeyboardShortcuts` switch exactly, so defaults are unchanged.
 */
export const SHORTCUTS: ShortcutDef[] = [
  {
    id: "view.files",
    label: "Go to Files",
    category: "View",
    defaultBinding: { mod: true, code: "Digit1" },
    whenTyping: true,
  },
  {
    id: "view.history",
    label: "Go to History",
    category: "View",
    defaultBinding: { mod: true, code: "Digit2" },
    whenTyping: true,
  },
  {
    id: "view.review",
    label: "Go to Review",
    category: "View",
    defaultBinding: { mod: true, code: "Digit3" },
    whenTyping: true,
  },
  {
    id: "view.pulls",
    label: "Go to Pull Requests",
    category: "View",
    defaultBinding: { mod: true, code: "Digit4" },
    whenTyping: true,
  },
  {
    id: "toggleSidebar",
    label: "Toggle repo sidebar",
    category: "Layout",
    defaultBinding: { mod: true, code: "KeyB" },
    whenTyping: true,
  },
  {
    id: "repoSearch",
    label: "Repo-wide search",
    category: "Layout",
    defaultBinding: { mod: true, shift: true, code: "KeyF" },
    whenTyping: true,
  },
  {
    id: "toggleTheme",
    label: "Toggle light/dark theme",
    category: "Layout",
    defaultBinding: { mod: true, code: "KeyJ" },
    whenTyping: true,
  },
  {
    id: "commandPalette",
    label: "Command palette",
    category: "Layout",
    defaultBinding: { mod: true, code: "KeyK" },
    whenTyping: true,
  },
  {
    id: "toggleTerminal",
    label: "Toggle terminal",
    category: "Layout",
    defaultBinding: { mod: true, code: "Backquote" },
    whenTyping: true,
  },
  {
    id: "maximizeTerminal",
    label: "Maximize / restore terminal",
    category: "Layout",
    defaultBinding: { mod: true, shift: true, code: "Backquote" },
    whenTyping: true,
  },
  {
    id: "openSettings",
    label: "Open settings",
    category: "Layout",
    defaultBinding: { mod: true, code: "Comma" },
    whenTyping: true,
  },
  {
    id: "push",
    label: "Push active repo",
    category: "Git",
    defaultBinding: { mod: true, shift: true, code: "KeyK" },
    whenTyping: false,
  },
  {
    id: "pull",
    label: "Pull active repo",
    category: "Git",
    defaultBinding: { mod: true, shift: true, code: "KeyP" },
    whenTyping: false,
  },
  {
    id: "fetchGroup",
    label: "Fetch all repos in group",
    category: "Git",
    defaultBinding: { mod: true, alt: true, code: "KeyF" },
    whenTyping: false,
  },
  {
    id: "cycleRepoNext",
    label: "Next repo in group",
    category: "Repos",
    defaultBinding: { ctrl: true, code: "Tab" },
    whenTyping: false,
  },
  {
    id: "cycleRepoPrev",
    label: "Previous repo in group",
    category: "Repos",
    defaultBinding: { ctrl: true, shift: true, code: "Tab" },
    whenTyping: false,
  },
];

export const SHORTCUT_BY_ID: Record<ShortcutId, ShortcutDef> = Object.fromEntries(
  SHORTCUTS.map((s) => [s.id, s]),
) as Record<ShortcutId, ShortcutDef>;

/** Best-effort macOS detection — drives the ⌘-vs-Ctrl primary modifier. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  // `userAgentData.platform` is the modern signal; fall back to the UA string.
  const p =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent;
  return /mac/i.test(p);
}

/** The concrete modifier booleans a binding requires on the current platform. */
function resolved(b: Binding, mac: boolean) {
  return {
    meta: mac ? !!b.mod : false,
    // On non-mac the primary modifier *is* Ctrl, so `mod` and literal `ctrl`
    // both map onto ctrlKey.
    ctrl: mac ? !!b.ctrl : !!b.mod || !!b.ctrl,
    alt: !!b.alt,
    shift: !!b.shift,
  };
}

/** Whether a keydown event matches a binding, modifiers and all. */
export function matchesBinding(e: KeyboardEvent, b: Binding, mac = isMac()): boolean {
  if (e.code !== b.code) return false;
  const r = resolved(b, mac);
  return (
    e.metaKey === r.meta && e.ctrlKey === r.ctrl && e.altKey === r.alt && e.shiftKey === r.shift
  );
}

/** Read a binding out of a keydown event (for the rebinding capture input). */
export function bindingFromEvent(e: KeyboardEvent, mac = isMac()): Binding {
  const b: Binding = { code: e.code };
  if (mac) {
    if (e.metaKey) b.mod = true;
    if (e.ctrlKey) b.ctrl = true;
  } else if (e.ctrlKey) {
    b.mod = true;
  }
  if (e.altKey) b.alt = true;
  if (e.shiftKey) b.shift = true;
  return b;
}

/** Modifier-only key codes — not a complete binding on their own. */
const MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
]);

/** Whether `code` is a modifier key (so a capture shouldn't commit on it alone). */
export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

/** A canonical, order-independent string for a binding — for conflict checks. */
export function bindingKey(b: Binding): string {
  return [
    b.mod ? "mod" : "",
    b.ctrl ? "ctrl" : "",
    b.alt ? "alt" : "",
    b.shift ? "shift" : "",
    b.code,
  ]
    .filter(Boolean)
    .join("+");
}

/** Human-readable label for a key code, e.g. "KeyK" → "K", "Digit1" → "1". */
function codeLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const named: Record<string, string> = {
    Backquote: "`",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Tab: "Tab",
    Space: "Space",
    Enter: "Enter",
    Escape: "Esc",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
  };
  return named[code] ?? code;
}

/** Format a binding for display, e.g. "⌘⇧K" on macOS or "Ctrl+Shift+K". */
export function formatBinding(b: Binding, mac = isMac()): string {
  if (mac) {
    let s = "";
    if (b.ctrl) s += "⌃";
    if (b.alt) s += "⌥";
    if (b.shift) s += "⇧";
    if (b.mod) s += "⌘";
    return s + codeLabel(b.code);
  }
  const parts: string[] = [];
  if (b.mod || b.ctrl) parts.push("Ctrl");
  if (b.alt) parts.push("Alt");
  if (b.shift) parts.push("Shift");
  parts.push(codeLabel(b.code));
  return parts.join("+");
}

/** Saved per-command overrides; only commands the user changed appear here. */
export type KeybindingOverrides = Partial<Record<ShortcutId, Binding>>;

/** Parse the `keybindings` setting (a JSON object) into typed overrides. */
export function parseOverrides(raw: string): KeybindingOverrides {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: KeybindingOverrides = {};
    for (const def of SHORTCUTS) {
      const v = parsed[def.id];
      if (v && typeof v === "object" && typeof (v as Binding).code === "string") {
        out[def.id] = v as Binding;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Merge defaults with overrides into the effective binding for every command. */
export function resolveBindings(overrides: KeybindingOverrides): Record<ShortcutId, Binding> {
  const out = {} as Record<ShortcutId, Binding>;
  for (const def of SHORTCUTS) {
    out[def.id] = overrides[def.id] ?? def.defaultBinding;
  }
  return out;
}

/**
 * Find commands that share a binding (so the UI can flag conflicts). Returns a
 * map from each conflicting command id to the other ids it collides with.
 */
export function findConflicts(
  bindings: Record<ShortcutId, Binding>,
): Partial<Record<ShortcutId, ShortcutId[]>> {
  const byKey = new Map<string, ShortcutId[]>();
  for (const def of SHORTCUTS) {
    const k = bindingKey(bindings[def.id]);
    byKey.set(k, [...(byKey.get(k) ?? []), def.id]);
  }
  const out: Partial<Record<ShortcutId, ShortcutId[]>> = {};
  for (const ids of byKey.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) out[id] = ids.filter((other) => other !== id);
  }
  return out;
}
