import { isTauri } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { create } from "zustand";

import { toast } from "@/store/toast";

/**
 * In-app auto-update (issue #1).
 *
 * The flow is: `check()` polls the signed `latest.json` on the GitHub Release;
 * if a newer version is found we surface it (banner + Settings), the user opts
 * in to `downloadAndInstall()`, and `restart()` relaunches into the new build.
 *
 * Tauri verifies each update's signature against the public key baked into
 * `tauri.conf.json`, so a tampered package is rejected before install.
 *
 * The updater plugin only exists inside the bundled desktop app — under
 * `pnpm dev` (plain Vite, no Tauri runtime) `check()` would throw, so every
 * entry point guards on `isTauri()` first.
 */

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "uptodate"
  | "error";

interface UpdaterState {
  status: UpdateStatus;
  /** The pending update handle, kept alive between check and install. */
  update: Update | null;
  /** Version offered by the manifest (set once an update is found). */
  version: string | null;
  /** Release notes from the manifest, if any. */
  notes: string | null;
  /** Download progress in [0, 1], or null when unknown / not downloading. */
  progress: number | null;
  error: string | null;
  /** Whether the user dismissed the banner for the current update. */
  dismissed: boolean;
  /**
   * Check for an update. `silent` suppresses the "up to date" / failure toasts
   * — used for the automatic check on launch so a flaky network is invisible.
   */
  check: (opts?: { silent?: boolean }) => Promise<void>;
  /** Download + install the pending update, tracking progress. */
  downloadAndInstall: () => Promise<void>;
  /** Relaunch into the freshly installed version. */
  restart: () => Promise<void>;
  dismiss: () => void;
}

export const useUpdater = create<UpdaterState>((set, get) => ({
  status: "idle",
  update: null,
  version: null,
  notes: null,
  progress: null,
  error: null,
  dismissed: false,

  check: async ({ silent = false } = {}) => {
    if (!isTauri()) {
      if (!silent) toast.info("Updates are only available in the installed app.");
      return;
    }
    const status = get().status;
    if (status === "checking" || status === "downloading") return;
    set({ status: "checking", error: null });
    try {
      const update = await check();
      if (update) {
        set({
          status: "available",
          update,
          version: update.version,
          notes: update.body ?? null,
          dismissed: false,
        });
      } else {
        set({ status: "uptodate", update: null, version: null, notes: null });
        if (!silent) toast.success("Gamut is up to date.");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ status: "error", error: msg });
      if (!silent) toast.error(`Update check failed: ${msg}`);
    }
  },

  downloadAndInstall: async () => {
    const update = get().update;
    if (!update) return;
    set({ status: "downloading", progress: 0, error: null });
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            set({ progress: 0 });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            set({ progress: total > 0 ? downloaded / total : null });
            break;
          case "Finished":
            set({ progress: 1 });
            break;
        }
      });
      set({ status: "ready", progress: 1, dismissed: false });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ status: "error", error: msg });
      toast.error(`Update failed: ${msg}`);
    }
  },

  restart: async () => {
    try {
      await relaunch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Couldn't restart: ${msg}`);
    }
  },

  dismiss: () => set({ dismissed: true }),
}));

/** Fire the silent launch check once (no-op outside the bundled app). */
export function checkForUpdatesOnLaunch() {
  void useUpdater.getState().check({ silent: true });
}
