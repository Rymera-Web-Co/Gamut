import { create } from "zustand";

export type Theme = "light" | "dark";

const STORAGE_KEY = "gamut.theme";

function systemTheme(): Theme {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function stored(): Theme | null {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" ? v : null;
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/** Apply the persisted/system theme before React renders, to avoid a flash. */
export function initTheme(): Theme {
  const theme = stored() ?? systemTheme();
  applyTheme(theme);
  return theme;
}

interface ThemeState {
  theme: Theme;
  toggle: () => void;
  set: (theme: Theme) => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  theme: stored() ?? systemTheme(),
  set: (theme) => {
    localStorage.setItem(STORAGE_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },
  toggle: () => get().set(get().theme === "dark" ? "light" : "dark"),
}));
