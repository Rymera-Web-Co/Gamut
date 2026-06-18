import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { create } from "zustand";

import { toast } from "@/store/toast";

/**
 * In-app auto-update (issue #1, rewired for nightly channels in #70).
 *
 * The flow is: `check_for_update` polls the signed `latest.json` on the GitHub
 * Release for the channel recorded in `pref.updateChannel`; if a newer version
 * is found we surface it (banner + Settings), the user opts in to
 * `download_and_install_update`, and `restart()` relaunches into the new build.
 *
 * Tauri verifies each update's signature against the public key baked into
 * `tauri.conf.json`, so a tampered package is rejected before install.
 *
 * The Rust commands only exist inside the bundled desktop app — under
 * `pnpm dev` (plain Vite, no Tauri runtime) `invoke`/`listen` would throw, so
 * every entry point guards on `isTauri()` first.
 */

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "uptodate"
  | "error";

/** Shape returned by the Rust `check_for_update` command. */
interface UpdateInfo {
  version: string;
  notes: string | null;
  date: string | null;
}

/** Payload emitted on the `updater://download` progress event. */
interface DownloadProgress {
  downloaded: number;
  total: number;
  done: boolean;
}

const PROGRESS_EVENT = "updater://download";

interface UpdaterState {
  status: UpdateStatus;
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
      const update = await invoke<UpdateInfo | null>("check_for_update");
      if (update) {
        set({
          status: "available",
          version: update.version,
          notes: update.notes,
          dismissed: false,
        });
      } else {
        set({ status: "uptodate", version: null, notes: null });
        if (!silent) toast.success("Gamut is up to date.");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ status: "error", error: msg });
      if (!silent) toast.error(`Update check failed: ${msg}`);
    }
  },

  downloadAndInstall: async () => {
    if (!isTauri()) return;
    const { status } = get();
    // Guard against concurrent invocation — the banner and Settings → About
    // both call this, and a double-click could otherwise start a second
    // download that interleaves progress with the first. Only an available
    // update can be installed.
    if (status !== "available") return;
    set({ status: "downloading", progress: 0, error: null });

    // Subscribe to progress before invoking so we don't miss early events;
    // tear the listener down once the install finishes or errors out.
    const unlisten = await listen<DownloadProgress>(PROGRESS_EVENT, (event) => {
      const { downloaded, total, done } = event.payload;
      if (done) {
        set({ status: "ready", progress: 1, dismissed: false });
      } else {
        set({ progress: total > 0 ? downloaded / total : null });
      }
    });

    try {
      await invoke<void>("download_and_install_update");
      // The progress listener flips status to "ready" on `done`, but invoke may
      // resolve without a terminal `done:true` event — settle it here too.
      if (get().status === "downloading") {
        set({ status: "ready", progress: 1, dismissed: false });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ status: "error", error: msg });
      toast.error(`Update failed: ${msg}`);
    } finally {
      unlisten();
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
