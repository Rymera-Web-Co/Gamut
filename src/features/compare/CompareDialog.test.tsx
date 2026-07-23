import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

import type { CompareResult } from "@/lib/ipc";

// The Compare save path goes through the ipc bridge; capture the call.
const writeCompareFile = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/ipc", () => ({
  ipc: { writeCompareFile },
  pickFile: () => Promise.resolve(null),
}));

// Stand-in Monaco: capture every addAction registration (id, keybindings, run)
// with its own dispose spy, so tests can assert the ⌘S action lifecycle without
// a real Monaco diff editor. `reset()` gives each test a clean pair of editors.
const h = vi.hoisted(() => {
  interface FakeAction {
    id: string;
    keybindings: number[];
    run: (...args: unknown[]) => unknown;
    dispose: ReturnType<typeof vi.fn>;
  }
  function makeEditor() {
    const actions: FakeAction[] = [];
    return {
      actions,
      getValue: () => "edited-content",
      onDidChangeModelContent: () => ({ dispose: () => {} }),
      addAction(descriptor: {
        id: string;
        keybindings: number[];
        run: (...a: unknown[]) => unknown;
      }) {
        const dispose = vi.fn();
        actions.push({ ...descriptor, dispose });
        return { dispose };
      },
    };
  }
  const state = { orig: makeEditor(), mod: makeEditor() };
  return {
    // Monaco's KeyMod/KeyCode constants used to build the ⌘S keybinding.
    monaco: { KeyMod: { CtrlCmd: 2048 }, KeyCode: { KeyS: 49 } },
    state,
    reset() {
      state.orig = makeEditor();
      state.mod = makeEditor();
    },
    diffEditor() {
      return {
        getOriginalEditor: () => state.orig,
        getModifiedEditor: () => state.mod,
      };
    },
  };
});

// CodeDiffEditor stub that fires onMount exactly once per mount (like the real
// one — Monaco's onMount is not re-fired on plain re-renders).
vi.mock("@/components/MonacoEditor", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    CodeDiffEditor: ({ onMount }: { onMount?: (editor: unknown, monaco: unknown) => void }) => {
      const onMountRef = useRef(onMount);
      onMountRef.current = onMount;
      useEffect(() => {
        onMountRef.current?.(h.diffEditor(), h.monaco);
      }, []);
      return null;
    },
  };
});

import { ResultView } from "./CompareDialog";

const CMD_S = 2048 | 49; // KeyMod.CtrlCmd | KeyCode.KeyS

function makeResult(overrides: Partial<CompareResult> = {}): CompareResult {
  return {
    left_text: "old left",
    right_text: "old right",
    left_label: "/tmp/a.txt",
    right_label: "/tmp/b.txt",
    is_binary: false,
    identical: false,
    ...overrides,
  };
}

function renderResult(result: CompareResult) {
  return render(<ResultView result={result} lang="plaintext" onSwap={() => {}} editable />);
}

describe("Compare dialog ⌘S action lifecycle (#276)", () => {
  beforeEach(() => {
    writeCompareFile.mockClear();
    h.reset();
  });

  it("registers ⌘S via addAction (a disposable) on both sides — never addCommand", () => {
    renderResult(makeResult());
    expect(h.state.orig.actions).toHaveLength(1);
    expect(h.state.mod.actions).toHaveLength(1);
    expect(h.state.orig.actions[0].keybindings).toContain(CMD_S);
    expect(h.state.mod.actions[0].keybindings).toContain(CMD_S);
  });

  it("disposes the ⌘S actions when the dialog view unmounts", () => {
    const { unmount } = renderResult(makeResult());
    const leftDispose = h.state.orig.actions[0].dispose;
    const rightDispose = h.state.mod.actions[0].dispose;
    expect(leftDispose).not.toHaveBeenCalled();
    unmount();
    expect(leftDispose).toHaveBeenCalledTimes(1);
    expect(rightDispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the prior action before re-registering on a new comparison (no leak)", () => {
    const { rerender } = renderResult(makeResult());
    const firstLeftDispose = h.state.orig.actions[0].dispose;
    // A new comparison changes the labels → the diff editor remounts.
    rerender(
      <ResultView
        result={makeResult({ left_label: "/tmp/c.txt", right_label: "/tmp/d.txt" })}
        lang="plaintext"
        onSwap={() => {}}
        editable
      />,
    );
    expect(firstLeftDispose).toHaveBeenCalledTimes(1);
    // The second registration exists and is live.
    expect(h.state.orig.actions).toHaveLength(2);
  });

  it("saves the focused side to the CURRENT result's path (no stale closure)", async () => {
    renderResult(makeResult({ left_label: "/tmp/current-left.txt" }));
    await act(async () => {
      await h.state.orig.actions[0].run();
    });
    expect(writeCompareFile).toHaveBeenCalledWith("/tmp/current-left.txt", "edited-content");
  });
});
