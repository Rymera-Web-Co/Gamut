import { useEffect } from "react";

import { useTheme } from "@/lib/theme";
import { useUiStore } from "@/store/ui";

/**
 * Global shortcuts:
 *   ⌘/Ctrl+1 → Files   ⌘/Ctrl+2 → History   ⌘/Ctrl+3 → Review
 *   ⌘/Ctrl+4 → Pull Requests
 *   ⌘/Ctrl+B → toggle repo sidebar   ⌘/Ctrl+J → toggle theme
 *   ⌘/Ctrl+⇧+F → repo-wide search (Files view)
 *   ⌘/Ctrl+` → toggle integrated terminal
 *   ⌘/Ctrl+⇧+` → maximize / restore the terminal
 *   ⌘/Ctrl+, → settings
 *
 * Per-file find/replace (⌘/Ctrl+F, ⌘/Ctrl+H) is handled in the Files view,
 * where the Monaco instance lives.
 */
export function useKeyboardShortcuts() {
  const setView = useUiStore((s) => s.setView);
  const toggleRepoSidebar = useUiStore((s) => s.toggleRepoSidebar);
  const toggleTerminal = useUiStore((s) => s.toggleTerminal);
  const toggleTerminalMaximized = useUiStore((s) => s.toggleTerminalMaximized);
  const toggleSettings = useUiStore((s) => s.toggleSettings);
  const focusRepoSearch = useUiStore((s) => s.focusRepoSearch);
  const toggleTheme = useTheme((s) => s.toggle);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      switch (e.key) {
        case "1":
          e.preventDefault();
          setView("files");
          break;
        case "2":
          e.preventDefault();
          setView("history");
          break;
        case "3":
          e.preventDefault();
          setView("review");
          break;
        case "4":
          e.preventDefault();
          setView("pulls");
          break;
        case "b":
          e.preventDefault();
          toggleRepoSidebar();
          break;
        // ⇧+F arrives as "F"; opens repo-wide search (plain ⌘/Ctrl+F is the
        // editor's per-file find, handled in the Files view).
        case "F":
          e.preventDefault();
          focusRepoSearch();
          break;
        case "j":
          e.preventDefault();
          toggleTheme();
          break;
        case "`":
          e.preventDefault();
          toggleTerminal();
          break;
        // Shift+` reports as "~" on most layouts.
        case "~":
          e.preventDefault();
          toggleTerminalMaximized();
          break;
        case ",":
          e.preventDefault();
          toggleSettings();
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    setView,
    toggleRepoSidebar,
    toggleTerminal,
    toggleTerminalMaximized,
    toggleSettings,
    focusRepoSearch,
    toggleTheme,
  ]);
}
