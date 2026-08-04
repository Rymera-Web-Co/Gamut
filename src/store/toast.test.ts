import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the Tauri `invoke` boundary is faked — everything above it (the real
// `src/lib/ipc.ts` wrappers, the real toast store) runs for real, so these
// tests prove the actual capture choke point (#301), not a stand-in for it.
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {},
}));

import { ipc, type Diagnostics } from "@/lib/ipc";
import { useToasts, toast } from "@/store/toast";

/** A minimal stateful fake backend: `errors_record` appends, and
 * `diagnostics_snapshot` reads back what was recorded — the same API the
 * Diagnostics panel consumes. */
function installFakeBackend() {
  const recorded: { at_ms: number; message: string }[] = [];
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "errors_record") {
      recorded.push({ at_ms: recorded.length + 1, message: String(args?.message) });
      return undefined;
    }
    if (cmd === "diagnostics_snapshot") {
      return {
        app_version: "0.0.0",
        os: "test",
        arch: "test",
        generated_at_ms: 0,
        repo_count: 0,
        group_count: 0,
        watched_path_count: 0,
        watch_failed_count: 0,
        op_stats: [],
        recent_ops: [],
        recent_errors: recorded,
      } satisfies Diagnostics;
    }
    return undefined;
  });
  return recorded;
}

/** Flush the microtask queue (a fire-and-forget `.then()`/`.catch()` chain
 * needs a real macrotask hop to fully settle in jsdom). */
function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

describe("toast error capture (#301)", () => {
  beforeEach(() => {
    invoke.mockReset();
    useToasts.setState({ toasts: [] });
  });

  it("push(msg, 'error') records through the real record path, readable from the panel's API", async () => {
    installFakeBackend();
    useToasts.getState().push("boom", "error");
    await flush();

    expect(invoke).toHaveBeenCalledWith("errors_record", { message: "boom" });
    const snapshot = await ipc.diagnostics();
    expect(snapshot.recent_errors?.some((e) => e.message === "boom")).toBe(true);
  });

  it("push(msg, 'success') and push(msg, 'info') record nothing", async () => {
    installFakeBackend();
    useToasts.getState().push("saved", "success");
    useToasts.getState().push("fyi", "info");
    await flush();

    expect(invoke).not.toHaveBeenCalledWith("errors_record", expect.anything());
  });

  it("toast.error(m) routes through the same choke point as push", async () => {
    installFakeBackend();
    toast.error("kaboom");
    await flush();

    expect(invoke).toHaveBeenCalledWith("errors_record", { message: "kaboom" });
  });

  it("tolerates a rejected record call: push neither throws nor rejects, and the toast still shows", async () => {
    invoke.mockRejectedValue(new Error("disk full"));

    expect(() => useToasts.getState().push("oops", "error")).not.toThrow();
    await flush();

    const toasts = useToasts.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe("error");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("tolerates a synchronously-throwing recorder — capture never perturbs the toast", async () => {
    // e.g. the frontend running outside Tauri, or a test that mocks
    // `@/lib/ipc` wholesale so `recordError` is absent. Recording is
    // best-effort; the error must still reach the user as a toast.
    invoke.mockImplementation(() => {
      throw new Error("tauri bridge unavailable");
    });

    expect(() => useToasts.getState().push("oops", "error")).not.toThrow();
    await flush();

    const toasts = useToasts.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("oops");
    expect(toasts[0].variant).toBe("error");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("a record failure does not re-enter push or re-invoke the recorder", async () => {
    invoke.mockRejectedValue(new Error("disk full"));

    useToasts.getState().push("oops", "error");
    await flush();
    await flush(); // a second flush would surface any feedback loop

    expect(useToasts.getState().toasts).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
