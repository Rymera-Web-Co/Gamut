import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Every sibling panel is stubbed so this test proves only the category
// wiring (rail click -> which panel body renders), not each panel's own
// behaviour — those live in each panel's own test file (e.g.
// RepoConfigPanel.test.tsx, DiagnosticsPanel.test.tsx). Mirrors the house
// convention of mocking out components not under test to avoid pulling in
// unrelated deps (see BranchSwitcher.test.tsx's `CleanupStaleDialog` mock).
vi.mock("./panels/AppearancePanel", () => ({ AppearancePanel: () => null }));
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
vi.mock("./panels/RepoConfigPanel", () => ({
  RepoConfigPanel: () => <div data-testid="repo-config-body">Repo config body</div>,
}));

import { SettingsDialog } from "./SettingsDialog";
import { useUiStore } from "@/store/ui";

describe("SettingsDialog — Repo config category (#306)", () => {
  it("A1/A27: opens the Repo config category and Diagnostics still opens its own content", () => {
    useUiStore.setState({ settingsOpen: true });
    render(<SettingsDialog />);

    fireEvent.click(screen.getByRole("button", { name: /Repo config/i }));
    expect(screen.getByTestId("repo-config-body")).toBeInTheDocument();
    expect(screen.queryByTestId("diagnostics-body")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Diagnostics$/i }));
    expect(screen.getByTestId("diagnostics-body")).toBeInTheDocument();
    expect(screen.queryByTestId("repo-config-body")).not.toBeInTheDocument();

    useUiStore.setState({ settingsOpen: false });
  });
});
