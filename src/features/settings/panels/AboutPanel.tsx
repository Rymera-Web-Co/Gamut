import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";

import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { useSettings, type Settings } from "@/lib/settings";
import { useUpdater } from "@/lib/updater";
import { Divider, Field, PanelTitle, Segmented } from "../controls";

export function AboutPanel() {
  const [version, setVersion] = useState<string | null>(null);
  const status = useUpdater((s) => s.status);
  const available = useUpdater((s) => s.version);
  const progress = useUpdater((s) => s.progress);
  const error = useUpdater((s) => s.error);
  const check = useUpdater((s) => s.check);
  const downloadAndInstall = useUpdater((s) => s.downloadAndInstall);
  const restart = useUpdater((s) => s.restart);
  const updateChannel = useSettings((s) => s.values.updateChannel);

  useEffect(() => {
    if (!isTauri()) return;
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  const checking = status === "checking";
  const downloading = status === "downloading";
  const pct = progress == null ? null : Math.round(progress * 100);

  const onChannelChange = (value: Settings["updateChannel"]) => {
    if (value === updateChannel) return;
    // Update the store immediately for responsive UI, but persist straight to
    // the DB and await it: the Rust `check_for_update` command reads
    // `pref.updateChannel` from the DB, so the value must be committed before
    // we re-check, not just queued via the store's fire-and-forget write.
    useSettings.getState().set("updateChannel", value);
    void ipc.setSetting("pref.updateChannel", value).then(() => useUpdater.getState().check());
  };

  return (
    <div>
      <PanelTitle>About</PanelTitle>
      <Field label="Version">
        <span className="text-sm text-[var(--color-muted-foreground)]">{version ?? "—"}</span>
      </Field>
      <Divider />
      <Field
        label="Update channel"
        hint="Stable ships reviewed releases. Nightly tracks the latest build."
      >
        <Segmented<Settings["updateChannel"]>
          value={updateChannel}
          onChange={onChannelChange}
          options={[
            { value: "stable", label: "Stable" },
            { value: "nightly", label: "Nightly" },
          ]}
        />
      </Field>
      {updateChannel === "nightly" && (
        <div className="mt-1 text-xs text-[var(--color-destructive)]">
          Nightly builds are unstable and ship the latest unreviewed code. On macOS they're
          unsigned, so Gatekeeper will warn before you can open them. Opt in only if you want the
          bleeding edge.
        </div>
      )}
      <Divider />
      <Field
        label="Updates"
        hint="Gamut checks for updates on launch. Updates are signed and verified before install."
      >
        {status === "available" ? (
          <Button size="sm" onClick={() => void downloadAndInstall()}>
            Download {available}
          </Button>
        ) : status === "ready" ? (
          <Button size="sm" onClick={() => void restart()}>
            Restart to update
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={checking || downloading}
            onClick={() => void check()}
          >
            {checking ? <Loader2 className="animate-spin" /> : null}
            {checking ? "Checking…" : "Check for updates"}
          </Button>
        )}
      </Field>
      {(downloading || status === "uptodate" || status === "error") && (
        <div className="mt-1 text-xs text-[var(--color-muted-foreground)]">
          {downloading && (pct == null ? "Downloading update…" : `Downloading update… ${pct}%`)}
          {status === "uptodate" && "You're on the latest version."}
          {status === "error" && (
            <span className="text-[var(--color-destructive)]">
              {error ?? "Update check failed."}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
