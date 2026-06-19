import { Download, Loader2, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useUpdater } from "@/lib/updater";

/**
 * Slim, in-flow bar pinned to the top of the window when an update is pending.
 * Rendered in normal layout (not fixed) so it never overlaps the group rail or
 * the toaster — it simply pushes the app down while visible.
 */
export function UpdateBanner() {
  const status = useUpdater((s) => s.status);
  const version = useUpdater((s) => s.version);
  const progress = useUpdater((s) => s.progress);
  const dismissed = useUpdater((s) => s.dismissed);
  const downloadAndInstall = useUpdater((s) => s.downloadAndInstall);
  const restart = useUpdater((s) => s.restart);
  const dismiss = useUpdater((s) => s.dismiss);

  const visible =
    !dismissed && (status === "available" || status === "downloading" || status === "ready");
  if (!visible) return null;

  const pct = progress == null ? null : Math.round(progress * 100);

  return (
    <div className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--color-primary)]/30 bg-[var(--color-primary)]/10 px-3 text-xs">
      {status === "available" && (
        <>
          <Download className="size-3.5 text-[var(--color-primary)]" />
          <span className="min-w-0 flex-1 truncate">
            A new version of Gamut
            {version ? ` (${version})` : ""} is available.
          </span>
          <Button size="sm" className="h-6" onClick={() => void downloadAndInstall()}>
            Download &amp; install
          </Button>
        </>
      )}

      {status === "downloading" && (
        <>
          <Loader2 className="size-3.5 animate-spin text-[var(--color-primary)]" />
          <span className="min-w-0 flex-1 truncate">
            Downloading update{pct == null ? "…" : `… ${pct}%`}
          </span>
          {pct != null && (
            <div className="h-1.5 w-32 overflow-hidden rounded-full bg-[var(--color-input)]">
              <div
                className="h-full rounded-full bg-[var(--color-primary)] transition-[width]"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </>
      )}

      {status === "ready" && (
        <>
          <RefreshCw className="size-3.5 text-[var(--color-primary)]" />
          <span className="min-w-0 flex-1 truncate">
            Update installed — restart Gamut to finish.
          </span>
          <Button size="sm" className="h-6" onClick={() => void restart()}>
            Restart now
          </Button>
        </>
      )}

      {/* Downloading is uninterruptible, so no dismiss while it runs. */}
      {status !== "downloading" && (
        <button
          onClick={dismiss}
          className="shrink-0 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
          aria-label="Dismiss"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
