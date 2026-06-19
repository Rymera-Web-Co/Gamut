import { create } from "zustand";

export type Theme = "light" | "dark";
/** What the user picked. "system" follows the OS appearance live. */
export type ThemePreference = Theme | "system";

const STORAGE_KEY = "gamut.theme";

function systemTheme(): Theme {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function storedPreference(): ThemePreference {
  const v = localStorage.getItem(STORAGE_KEY);
  // Anything unrecognised (incl. a never-set key) follows the system — this is
  // what restores a working "System" option after the first manual toggle.
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

function resolve(pref: ThemePreference): Theme {
  return pref === "system" ? systemTheme() : pref;
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/** Apply the persisted/system theme before React renders, to avoid a flash. */
export function initTheme(): Theme {
  const theme = resolve(storedPreference());
  applyTheme(theme);
  return theme;
}

interface ThemeState {
  /** The user's choice: light, dark, or system. */
  preference: ThemePreference;
  /** The resolved theme currently applied to the document. */
  theme: Theme;
  setPreference: (preference: ThemePreference) => void;
  /** Flip between light/dark, pinning the choice explicitly (⌘J). */
  toggle: () => void;
  /** Back-compat alias for setting an explicit light/dark preference. */
  set: (theme: Theme) => void;
}

export const useTheme = create<ThemeState>((set, get) => {
  // Track OS appearance changes so "system" stays live without a restart.
  if (typeof window !== "undefined" && window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener?.("change", () => {
      if (get().preference !== "system") return;
      const theme = systemTheme();
      applyTheme(theme);
      set({ theme });
    });
  }

  const preference = storedPreference();
  return {
    preference,
    theme: resolve(preference),
    setPreference: (preference) => {
      localStorage.setItem(STORAGE_KEY, preference);
      const theme = resolve(preference);
      applyTheme(theme);
      set({ preference, theme });
    },
    toggle: () => get().setPreference(get().theme === "dark" ? "light" : "dark"),
    set: (theme) => get().setPreference(theme),
  };
});
