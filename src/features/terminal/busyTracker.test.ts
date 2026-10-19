import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUSY_IDLE_MS, ECHO_WINDOW_MS, createBusyTracker } from "./busyTracker";

describe("createBusyTracker", () => {
  let onChange: ReturnType<typeof vi.fn<(busy: boolean) => void>>;
  let tracker: ReturnType<typeof createBusyTracker>;

  beforeEach(() => {
    vi.useFakeTimers();
    onChange = vi.fn<(busy: boolean) => void>();
    tracker = createBusyTracker(onChange, () => Date.now());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("goes busy on output and idle after the quiet period", () => {
    tracker.output();
    expect(onChange).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(BUSY_IDLE_MS - 1);
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("stays busy while output keeps arriving, and reports busy only once", () => {
    tracker.output();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(BUSY_IDLE_MS - 100);
      tracker.output();
    }
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(BUSY_IDLE_MS);
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("ignores output right after a keystroke or resize", () => {
    tracker.suppress();
    vi.advanceTimersByTime(ECHO_WINDOW_MS - 1);
    tracker.output();
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    tracker.output();
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it("stop goes idle at once and cancels the timer", () => {
    tracker.output();
    tracker.stop();
    expect(onChange).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(BUSY_IDLE_MS * 2);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("stop is a no-op when idle", () => {
    tracker.stop();
    expect(onChange).not.toHaveBeenCalled();
  });
});
