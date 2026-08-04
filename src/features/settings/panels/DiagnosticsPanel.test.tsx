import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Only the Tauri `invoke` boundary (and the clipboard plugin it bottoms out
// through) is faked — the real ipc wrappers, the real toast store, and the
// real panel all run for real (#301).
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {},
}));

const writeText = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText }));

import type { Diagnostics, ErrorEntry } from "@/lib/ipc";
import { toast, useToasts } from "@/store/toast";
import { DiagnosticsPanel } from "./DiagnosticsPanel";

function baseSnapshot(overrides?: Partial<Diagnostics>): Diagnostics {
  return {
    app_version: "1.0.0",
    os: "macos",
    arch: "aarch64",
    generated_at_ms: 0,
    repo_count: 3,
    group_count: 1,
    watched_path_count: 5,
    watch_failed_count: 0,
    op_stats: [],
    recent_ops: [],
    recent_errors: [],
    ...overrides,
  };
}

/** Flush the microtask queue (a fire-and-forget chain needs a macrotask hop
 * to fully settle in jsdom). */
function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  invoke.mockReset();
  writeText.mockClear();
  useToasts.setState({ toasts: [] });
  // Clear is guarded by a confirm (it deletes the only copy of the errors);
  // default to accepting so the tests that aren't about the guard aren't
  // blocked by it.
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DiagnosticsPanel — Recent errors (#301)", () => {
  it("shows the exact empty state for a loaded snapshot with no errors (A18)", async () => {
    invoke.mockResolvedValue(baseSnapshot({ recent_errors: [] }));
    render(<DiagnosticsPanel />);
    expect(await screen.findByText("No errors recorded.")).toBeInTheDocument();
  });

  it("does not throw when recent_errors is undefined; op timings still render (A19)", async () => {
    const snapshot = baseSnapshot({
      op_stats: [{ op: "git_status", count: 2, fail_count: 0, max_ms: 10, avg_ms: 5 }],
    });
    delete (snapshot as Partial<Diagnostics>).recent_errors;
    invoke.mockResolvedValue(snapshot);

    render(<DiagnosticsPanel />);

    expect(await screen.findByText("git_status")).toBeInTheDocument();
    expect(screen.getByText("No errors recorded.")).toBeInTheDocument();
  });

  it("lists entries newest-first by insertion order, not a timestamp sort (A16)", async () => {
    const entries: ErrorEntry[] = [
      { at_ms: 1000, message: "first" },
      { at_ms: 1000, message: "second" },
      { at_ms: 1000, message: "third" },
    ];
    invoke.mockResolvedValue(baseSnapshot({ recent_errors: entries }));

    render(<DiagnosticsPanel />);
    await screen.findByText("third");

    const rendered = screen.getAllByText(/^(first|second|third)$/).map((el) => el.textContent);
    expect(rendered).toEqual(["third", "second", "first"]);
  });

  it("renders each row's timestamp as exactly YYYY-MM-DD HH:MM:SS (A17)", async () => {
    invoke.mockResolvedValue(
      baseSnapshot({ recent_errors: [{ at_ms: 1_709_802_303_000, message: "boom" }] }),
    );
    render(<DiagnosticsPanel />);
    expect(await screen.findByText("2024-03-07 09:05:03")).toBeInTheDocument();
  });

  it("the panel's Copy button payload contains a recorded error message (A15)", async () => {
    invoke.mockResolvedValue(
      baseSnapshot({ recent_errors: [{ at_ms: 1, message: "distinctive-boom-9001" }] }),
    );
    render(<DiagnosticsPanel />);
    await screen.findByText("distinctive-boom-9001");

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain("distinctive-boom-9001");
  });

  it("per-row copy is an unambiguous ISO timestamp plus the full verbatim message (A20)", async () => {
    const message = "line one\nline two\nline three (never truncated by the visual clamp)";
    invoke.mockResolvedValue(
      baseSnapshot({ recent_errors: [{ at_ms: 1_709_802_303_000, message }] }),
    );
    render(<DiagnosticsPanel />);
    // The row displays local time…
    await screen.findByText("2024-03-07 09:05:03");

    // …and the per-row control names which row it copies, so a screen-reader
    // user gets distinguishable buttons rather than N identical "Copy error"s.
    fireEvent.click(screen.getByRole("button", { name: "Copy error from 2024-03-07 09:05:03" }));

    // …but the copied payload carries a UTC offset, because it's headed for a
    // bug report where a bare local time can't be correlated.
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`2024-03-07T09:05:03.000Z  ${message}`),
    );
  });

  it("Copy all writes every entry newest-first, newline-separated, in exactly one write (A21)", async () => {
    const entries: ErrorEntry[] = [
      { at_ms: 1_709_802_303_000, message: "one" },
      { at_ms: 1_709_802_304_000, message: "two" },
    ];
    invoke.mockResolvedValue(baseSnapshot({ recent_errors: entries }));
    render(<DiagnosticsPanel />);
    await screen.findByText("two");

    fireEvent.click(screen.getByRole("button", { name: "Copy all" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(
      "2024-03-07T09:05:04.000Z  two\n2024-03-07T09:05:03.000Z  one",
    );
  });

  it("Copy all is disabled, writes nothing, and shows no success toast with zero entries (A21)", async () => {
    invoke.mockResolvedValue(baseSnapshot({ recent_errors: [] }));
    render(<DiagnosticsPanel />);
    await screen.findByText("No errors recorded.");

    const copyAll = screen.getByRole("button", { name: "Copy all" });
    expect(copyAll).toBeDisabled();

    fireEvent.click(copyAll);
    await flush();

    expect(writeText).not.toHaveBeenCalled();
    expect(useToasts.getState().toasts.some((t) => t.variant === "success")).toBe(false);
  });

  it("a rejected clear leaves the list intact and surfaces an error, without recursing (A23)", async () => {
    const entries: ErrorEntry[] = [{ at_ms: 1, message: "keep-me" }];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "diagnostics_snapshot") return baseSnapshot({ recent_errors: entries });
      if (cmd === "errors_clear") throw new Error("locked");
      return undefined;
    });

    render(<DiagnosticsPanel />);
    await screen.findByText("keep-me");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() =>
      expect(useToasts.getState().toasts.some((t) => t.variant === "error")).toBe(true),
    );
    // Not shown as cleared.
    expect(screen.getByText("keep-me")).toBeInTheDocument();
    // No recursion into the clear command itself.
    const clearCalls = invoke.mock.calls.filter(([cmd]) => cmd === "errors_clear");
    expect(clearCalls).toHaveLength(1);
  });

  it("Clear is guarded: declining the confirm deletes nothing", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    invoke.mockResolvedValue(baseSnapshot({ recent_errors: [{ at_ms: 1, message: "keep-me" }] }));
    render(<DiagnosticsPanel />);
    await screen.findByText("keep-me");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await flush();

    expect(invoke.mock.calls.filter(([cmd]) => cmd === "errors_clear")).toHaveLength(0);
    expect(screen.getByText("keep-me")).toBeInTheDocument();
  });

  it("Clear is disabled with zero entries, like its Copy all sibling", async () => {
    invoke.mockResolvedValue(baseSnapshot({ recent_errors: [] }));
    render(<DiagnosticsPanel />);
    await screen.findByText("No errors recorded.");

    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  // A24: real toast store + real panel, only `invoke` faked — proves the two
  // halves are wired to the same backend ring rather than each passing its
  // own unit tests in isolation.
  it("end-to-end: a toast.error message appears in the panel's Recent errors list (A24)", async () => {
    const recorded: ErrorEntry[] = [];
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "errors_record") {
        recorded.push({ at_ms: recorded.length + 1, message: String(args?.message) });
        return undefined;
      }
      if (cmd === "diagnostics_snapshot") {
        return baseSnapshot({ recent_errors: recorded });
      }
      return undefined;
    });

    toast.error("wired-together-message");
    await flush();

    render(<DiagnosticsPanel />);

    expect(await screen.findByText("wired-together-message")).toBeInTheDocument();
  });
});
