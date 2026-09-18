import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULTS, useSettings } from "@/lib/settings";

// Drive the real click path: capture the handler `onAction` registers, then
// deliver a clicked notification's payload to it.
const tauri = vi.hoisted(() => ({
  action: null as ((n: { extra?: Record<string, unknown> }) => void) | null,
  sendNotification: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(() => Promise.resolve(true)),
  requestPermission: vi.fn(() => Promise.resolve("granted")),
  sendNotification: tauri.sendNotification,
  onAction: vi.fn((cb: (n: { extra?: Record<string, unknown> }) => void) => {
    tauri.action = cb;
    return Promise.resolve(() => {});
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    unminimize: () => Promise.resolve(),
    show: () => Promise.resolve(),
    setFocus: () => Promise.resolve(),
  }),
}));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    playNotificationSound: vi.fn(() => Promise.resolve()),
    terminalRegistryReport: vi.fn(() => Promise.resolve()),
  },
}));

import { useUiStore } from "@/store/ui";
import { notifyTerminalEvent } from "./notify";

beforeEach(() => {
  localStorage.clear();
  tauri.sendNotification.mockClear();
  useSettings.setState({
    values: { ...DEFAULTS, terminalNotifyDesktop: true, terminalNotifySound: false },
  });
  useUiStore.setState({
    activeGroupId: 1,
    activeRepoId: 7,
    view: "history",
    terminalOpen: false,
    terminals: {
      activeTabId: null,
      tabs: [
        {
          id: "tab-2",
          groupId: 2,
          title: "worker",
          panes: [{ id: "term-2", cwd: "/repos/beta" }],
          activePaneId: "term-2",
        },
      ],
    },
  });
});

// #339's strongest case: a bell fires in a background terminal that belongs to
// another group. Clicking the notification must show that terminal without
// throwing the whole workspace into its group.
describe("terminal notification click (#339)", () => {
  it("reveals the pane's terminal without moving the active group", async () => {
    notifyTerminalEvent({
      kind: "bell",
      title: "worker",
      target: { tabId: "tab-2", paneId: "term-2" },
    });
    await vi.waitFor(() => expect(tauri.sendNotification).toHaveBeenCalled());

    const extra = tauri.sendNotification.mock.calls[0][0].extra as Record<string, unknown>;
    tauri.action!({ extra });

    const s = useUiStore.getState();
    expect(s.terminalOpen).toBe(true);
    expect(s.terminals.activeTabId).toBe("tab-2");
    // The workspace stays exactly where the user left it.
    expect(s.activeGroupId).toBe(1);
    expect(s.activeRepoId).toBe(7);
    expect(s.view).toBe("history");
  });
});
