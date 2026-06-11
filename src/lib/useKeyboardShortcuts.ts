import { useEffect } from "react";

import { useTheme } from "@/lib/theme";
import { useUiStore } from "@/store/ui";

/**
 * Global shortcuts:
 *   ⌘/Ctrl+1 → History   ⌘/Ctrl+2 → Review   ⌘/Ctrl+3 → Pull Requests
 *   ⌘/Ctrl+B → toggle repo sidebar   ⌘/Ctrl+J → toggle theme
 */
export function useKeyboardShortcuts() {
  const setView = useUiStore((s) => s.setView);
  const toggleRepoSidebar = useUiStore((s) => s.toggleRepoSidebar);
  const toggleTheme = useTheme((s) => s.toggle);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      switch (e.key) {
        case "1":
          e.preventDefault();
          setView("history");
          break;
        case "2":
          e.preventDefault();
          setView("review");
          break;
        case "3":
          e.preventDefault();
          setView("pulls");
          break;
        case "b":
          e.preventDefault();
          toggleRepoSidebar();
          break;
        case "j":
          e.preventDefault();
          toggleTheme();
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setView, toggleRepoSidebar, toggleTheme]);
}
