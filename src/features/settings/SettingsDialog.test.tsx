import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Every sibling panel is stubbed so this test proves only the category
// wiring (rail click -> which panel body renders), not each panel's own
// behaviour — those live in each panel's own test file (e.g.
// DiagnosticsPanel.test.tsx). Mirrors the house convention of mocking out
// components not under test to avoid pulling in unrelated deps (see
// BranchSwitcher.test.tsx's `CleanupStaleDialog` mock).
vi.mock("./panels/AppearancePanel", () => ({
  AppearancePanel: () => <div data-testid="appearance-body">Appearance body</div>,
}));
vi.mock("./panels/DiffPanel", () => ({ DiffPanel: () => null }));
vi.mock("./panels/GitPanel", () => ({ GitPanel: () => null }));
vi.mock("./panels/GitHubPanel", () => ({ GitHubPanel: () => null }));
vi.mock("./panels/TerminalPanel", () => ({ TerminalPanel: () => null }));
vi.mock("./panels/CommandPalettePanel", () => ({ CommandPalettePanel: () => null }));
vi.mock("./panels/KeyboardPanel", () => ({ KeyboardPanel: () => null }));
vi.mock("./panels/NotificationsPanel", () => ({ NotificationsPanel: () => null }));
vi.mock("./panels/AboutPanel", () => ({ AboutPanel: () => null }));
vi.mock("./panels/DiagnosticsPanel", () => ({
  DiagnosticsPanel: () => <div data-testid="diagnostics-body">Diagnostics body</div>,
}));

import { SettingsDialog } from "./SettingsDialog";
import { useUiStore } from "@/store/ui";

describe("SettingsDialog category rail (#306 follow-up)", () => {
  it("a pre-existing category (Diagnostics) still opens its own content when clicked", () => {
    useUiStore.setState({ settingsOpen: true });
    render(<SettingsDialog />);

    // Starts on the default category (Appearance)...
    expect(screen.getByTestId("appearance-body")).toBeInTheDocument();

    // ...and clicking another category swaps the content, not just adds to it.
    fireEvent.click(screen.getByRole("button", { name: /^Diagnostics$/i }));
    expect(screen.getByTestId("diagnostics-body")).toBeInTheDocument();
    expect(screen.queryByTestId("appearance-body")).not.toBeInTheDocument();

    useUiStore.setState({ settingsOpen: false });
  });
});
