import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULTS, useSettings } from "@/lib/settings";
import { TerminalPanel } from "./TerminalPanel";

beforeEach(() => {
  localStorage.clear();
  useSettings.setState({ values: { ...DEFAULTS } });
});

// #339: the decoupled behaviour is the default, so today's coupling is the
// opt-in. A default of `true` here would silently ship the old behaviour.
describe('Settings > Terminal "Follow terminal into its group" (#339)', () => {
  it("defaults to off", () => {
    expect(DEFAULTS.terminalFollowGroup).toBe(false);
  });

  it("renders an unchecked toggle that flips the stored value", () => {
    render(<TerminalPanel />);

    // The label sits in the Field's left column; the toggle is in its right.
    const row = screen.getByText("Follow terminal into its group").parentElement!.parentElement!;
    const toggle = row.querySelector('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    expect(useSettings.getState().values.terminalFollowGroup).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});
