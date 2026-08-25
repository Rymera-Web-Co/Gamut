import { createElement, type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// Raw source imports (Vite `?raw`) so A13 can check the invoke_handler list
// without pulling node:fs into the browser-targeted `src` tsconfig.
import libRs from "../../../src-tauri/src/lib.rs?raw";
import ipcTs from "../../lib/ipc.ts?raw";

// Exercise the new mutations' onSuccess invalidation against a real
// QueryClient (#334), the same way the rest of this suite treats query-key
// contracts as behavior, not source text.
vi.mock("@/lib/ipc", () => ({
  ipc: {
    githubRequestReview: vi.fn(() => Promise.resolve()),
    githubRemoveReviewRequest: vi.fn(() => Promise.resolve()),
    githubAddAssignees: vi.fn(() => Promise.resolve()),
    githubRemoveAssignees: vi.fn(() => Promise.resolve()),
  },
}));

import {
  useRequestReview,
  useRemoveReviewRequest,
  useAddAssignees,
  useRemoveAssignees,
} from "./api";

const REPO_ID = 42;
const NUMBER = 7;
const EXPECTED_KEYS = [
  ["github-pr-details", REPO_ID, NUMBER],
  ["github-pr-thread", REPO_ID, NUMBER],
  ["github-prs", REPO_ID],
];

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(qc, "invalidateQueries");
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return { Wrapper, spy };
}

function assertInvalidatedTrio(spy: ReturnType<typeof vi.spyOn>) {
  for (const key of EXPECTED_KEYS) {
    expect(spy).toHaveBeenCalledWith({ queryKey: key });
  }
}

describe("PR reviewer/assignee mutations — onSuccess invalidation (#334)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("A9: useRemoveReviewRequest invalidates the same trio as useRequestReview", async () => {
    const { Wrapper, spy } = wrapper();
    const { result } = renderHook(() => useRemoveReviewRequest(REPO_ID), { wrapper: Wrapper });
    await result.current.mutateAsync({ number: NUMBER, reviewers: ["alice"] });
    assertInvalidatedTrio(spy);
  });

  it("A9: useAddAssignees invalidates the same trio as useRequestReview", async () => {
    const { Wrapper, spy } = wrapper();
    const { result } = renderHook(() => useAddAssignees(REPO_ID), { wrapper: Wrapper });
    await result.current.mutateAsync({ number: NUMBER, assignees: ["alice"] });
    assertInvalidatedTrio(spy);
  });

  it("A9: useRemoveAssignees invalidates the same trio as useRequestReview", async () => {
    const { Wrapper, spy } = wrapper();
    const { result } = renderHook(() => useRemoveAssignees(REPO_ID), { wrapper: Wrapper });
    await result.current.mutateAsync({ number: NUMBER, assignees: ["alice"] });
    assertInvalidatedTrio(spy);
  });

  it("A9: useRequestReview (existing) invalidates the same trio, for comparison", async () => {
    const { Wrapper, spy } = wrapper();
    const { result } = renderHook(() => useRequestReview(REPO_ID), { wrapper: Wrapper });
    await result.current.mutateAsync({ number: NUMBER, reviewers: ["alice"] });
    assertInvalidatedTrio(spy);
  });
});

describe("Rust invoke_handler registration (#334)", () => {
  it('A13: every TS invoke("…") command is registered in lib.rs\'s invoke_handler', () => {
    // Derive the command list from the bridge itself rather than hardcoding it,
    // so the next unregistered command fails here too (#334). The generic is
    // matched non-greedily so nested generics (e.g. `Record<string, string>`)
    // still resolve to the command string that follows.
    const commands = [...ipcTs.matchAll(/\binvoke<[\s\S]*?>\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
    // Sanity check the parse itself: a regex that silently stops matching would
    // otherwise turn this contract test into a no-op.
    expect(commands.length).toBeGreaterThan(100);

    // The handler list is one `commands::<module>::<name>,` entry per line.
    const registered = new Set(
      [...libRs.matchAll(/^\s*commands::[a-z0-9_:]*?([a-z0-9_]+),\s*$/gm)].map((m) => m[1]),
    );
    const missing = commands.filter((c) => !registered.has(c));
    expect(missing).toEqual([]);
  });
});
