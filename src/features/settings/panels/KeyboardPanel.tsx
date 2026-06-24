import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
import { PanelTitle, useSetting } from "../controls";

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

export function KeyboardPanel() {
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
