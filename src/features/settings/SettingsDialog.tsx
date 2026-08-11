import { useState } from "react";
import {
  Activity,
  Bell,
  Command,
  FileCog,
  GitCompare,
  GitFork,
  Github,
  Info,
  Keyboard,
  Palette,
  RotateCcw,
  SquareTerminal,
} from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSettings } from "@/lib/settings";
import { useTheme } from "@/lib/theme";
import { useUiStore } from "@/store/ui";
import { AppearancePanel } from "./panels/AppearancePanel";
import { DiffPanel } from "./panels/DiffPanel";
import { GitPanel } from "./panels/GitPanel";
import { GitHubPanel } from "./panels/GitHubPanel";
import { RepoConfigPanel } from "./panels/RepoConfigPanel";
import { TerminalPanel } from "./panels/TerminalPanel";
import { CommandPalettePanel } from "./panels/CommandPalettePanel";
import { KeyboardPanel } from "./panels/KeyboardPanel";
import { NotificationsPanel } from "./panels/NotificationsPanel";
import { DiagnosticsPanel } from "./panels/DiagnosticsPanel";
import { AboutPanel } from "./panels/AboutPanel";

const CATEGORIES = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "diff", label: "Diff & Review", icon: GitCompare },
  { id: "git", label: "Git & Repos", icon: GitFork },
  { id: "repo-config", label: "Repo config", icon: FileCog },
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
          {category === "repo-config" && <RepoConfigPanel />}
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
