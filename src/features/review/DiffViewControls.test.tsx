import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, renderHook } from "@testing-library/react";

// The settings store persists each write to the DB over the ipc bridge; there is
// no Tauri backend under jsdom, so stub the fire-and-forget call.
vi.mock("@/lib/ipc", () => ({
  ipc: {
    getSettings: vi.fn(() => Promise.resolve({})),
    setSetting: vi.fn(() => Promise.resolve()),
  },
}));

import { DEFAULTS, useDiffEditorPrefs, useSettings } from "@/lib/settings";
import { DiffViewControls } from "./DiffViewControls";

describe("DiffViewControls (#284)", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettings.setState({ values: { ...DEFAULTS } });
  });

  it("reflects the effective defaults on first render — unset settings (A4/A7)", () => {
    // Defaults: side-by-side layout, word wrap off. Nothing preset.
    render(<DiffViewControls />);
    const sideBySide = screen.getByRole("button", { name: "Side by side" });
    const unified = screen.getByRole("button", { name: "Unified" });
    expect(sideBySide.className).toContain("bg-[var(--color-secondary)]");
    expect(unified.className).not.toContain("bg-[var(--color-secondary)]");
    expect(screen.getByRole("button", { name: "Word wrap" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("offers both layouts and marks the current one active (A1/A4)", () => {
    useSettings.setState({ values: { ...DEFAULTS, diffLayout: "unified" } });
    render(<DiffViewControls />);

    const sideBySide = screen.getByRole("button", { name: "Side by side" });
    const unified = screen.getByRole("button", { name: "Unified" });
    expect(sideBySide).toBeInTheDocument();
    expect(unified.className).toContain("bg-[var(--color-secondary)]");
    expect(sideBySide.className).not.toContain("bg-[var(--color-secondary)]");
  });

  it("persists the picked layout to the SAME global value the diff renderer reads (A3/A8)", () => {
    render(<DiffViewControls />);
    // The renderer consumes `useDiffEditorPrefs()` — assert the round-trip, not
    // just a store field, so the toggle can't drift onto a duplicate key.
    const prefs = renderHook(() => useDiffEditorPrefs());
    expect(prefs.result.current.renderSideBySide).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Unified" }));
    expect(useSettings.getState().values.diffLayout).toBe("unified");
    prefs.rerender();
    expect(prefs.result.current.renderSideBySide).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
    prefs.rerender();
    expect(prefs.result.current.renderSideBySide).toBe(true);
  });

  it("word-wrap toggle flips the SAME global value the diff renderer reads (A5/A6/A7)", () => {
    render(<DiffViewControls />);
    const prefs = renderHook(() => useDiffEditorPrefs());
    const wrap = screen.getByRole("button", { name: "Word wrap" });

    // Off by default → not pressed; renderer sees Monaco's "off".
    expect(wrap).toHaveAttribute("aria-pressed", "false");
    expect(prefs.result.current.wordWrap).toBe("off");

    fireEvent.click(wrap);
    expect(useSettings.getState().values.editorWordWrap).toBe(true);
    prefs.rerender();
    expect(prefs.result.current.wordWrap).toBe("on");
    expect(screen.getByRole("button", { name: "Word wrap" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Word wrap" }));
    prefs.rerender();
    expect(prefs.result.current.wordWrap).toBe("off");
  });
});
