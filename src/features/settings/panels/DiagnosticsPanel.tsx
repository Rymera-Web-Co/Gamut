import { useEffect, useState } from "react";
import { Copy, Download, Loader2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { copy } from "@/lib/clipboard";
import { formatTimestampMs } from "@/lib/format";
import { ipc, pickSavePath, type Diagnostics, type ErrorEntry } from "@/lib/ipc";
import { toast } from "@/store/toast";
import { Divider, PanelTitle } from "../controls";

/**
 * Render an error entry's copy payload — shared by per-row and "Copy all".
 *
 * Uses an ISO-8601 UTC stamp rather than the row's local-time display format:
 * this text is headed for a bug report, where a bare local time with no offset
 * can't be correlated against a UTC log, a CI run, or another reporter's paste.
 * The row itself still shows local time, which is what the user recognises.
 */
function errorRowText(entry: ErrorEntry): string {
  return `${new Date(entry.at_ms).toISOString()}  ${entry.message}`;
}

export function DiagnosticsPanel() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = () => {
    setLoading(true);
    ipc
      .diagnostics()
      .then(setData)
      .catch(() => toast.error("Could not load diagnostics"))
      .finally(() => setLoading(false));
  };

  // Load whenever the panel mounts (i.e. the category is opened).
  useEffect(refresh, []);

  const onCopy = async () => {
    const snapshot = await ipc.diagnostics().catch(() => null);
    if (!snapshot) return toast.error("Could not load diagnostics");
    await copy(JSON.stringify(snapshot, null, 2), "Diagnostics copied to clipboard");
  };

  const onSave = async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const path = await pickSavePath(`gamut-diagnostics-${stamp}.json`);
    if (!path) return;
    try {
      await ipc.diagnosticsWrite(path);
      toast.success("Diagnostics saved");
    } catch (e) {
      toast.error(String(e));
    }
  };

  // Read defensively: an older/partial snapshot without the field must not
  // blank the whole panel (#301).
  const errors = data?.recent_errors ?? [];
  // Newest-first by insertion order — never a timestamp sort, so entries
  // recorded in the same millisecond keep a stable order.
  const errorsNewestFirst = [...errors].reverse();

  const onCopyErrorRow = async (entry: ErrorEntry) => {
    await copy(errorRowText(entry), "Error copied to clipboard");
  };

  const onCopyAllErrors = async () => {
    if (errorsNewestFirst.length === 0) return;
    await copy(errorsNewestFirst.map(errorRowText).join("\n"), "Errors copied to clipboard");
  };

  const onClearErrors = async () => {
    // Guarded: this permanently deletes both the ring and `errors.log`, which
    // is the only copy of the errors the user most likely opened this panel to
    // retrieve — and the button sits right next to a copy control.
    const count = errorsNewestFirst.length;
    if (
      !window.confirm(`Delete ${count} recorded error${count === 1 ? "" : "s"}? Can't be undone.`)
    )
      return;
    try {
      await ipc.clearErrors();
      // Re-read from the backend rather than optimistically emptying local
      // state, so a rejected clear (below) leaves the list intact (#301).
      refresh();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const stalls = data?.op_stats.find((s) => s.op === "ui_stall");

  return (
    <div>
      <PanelTitle>Diagnostics</PanelTitle>
      <p className="mb-2 text-xs text-[var(--color-muted-foreground)]">
        Timing for the heavy git operations, plus a snapshot of the current setup. If the app
        freezes or feels slow, copy or save this and share it so we can pinpoint what's blocking.
      </p>

      <div className="mb-3 flex gap-2">
        <Button variant="outline" size="sm" className="h-8" onClick={refresh}>
          {loading ? <Loader2 className="animate-spin" /> : <RotateCcw className="size-3.5" />}
          Refresh
        </Button>
        <Button variant="outline" size="sm" className="h-8" onClick={() => void onCopy()}>
          <Copy className="size-3.5" />
          Copy
        </Button>
        <Button variant="outline" size="sm" className="h-8" onClick={() => void onSave()}>
          <Download className="size-3.5" />
          Save…
        </Button>
      </div>

      {data && (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <DiagRow label="Version" value={data.app_version} />
            <DiagRow label="Platform" value={`${data.os} (${data.arch})`} />
            <DiagRow label="Repositories" value={String(data.repo_count)} />
            <DiagRow label="Groups" value={String(data.group_count)} />
            <DiagRow label="Watched paths" value={String(data.watched_path_count)} />
            {data.watch_failed_count > 0 && (
              <DiagRow label="Watch failures" value={String(data.watch_failed_count)} danger />
            )}
            {stalls && (
              <DiagRow label="UI stalls" value={`${stalls.count} (max ${stalls.max_ms} ms)`} />
            )}
          </div>

          <Divider />
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
            Operation timings (recent)
          </div>
          {data.op_stats.length === 0 ? (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              No operations recorded yet — interact with a repo and refresh.
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[var(--color-muted-foreground)]">
                <tr className="text-left">
                  <th className="py-1 font-medium">Operation</th>
                  <th className="py-1 text-right font-medium">Count</th>
                  <th className="py-1 text-right font-medium">Avg</th>
                  <th className="py-1 text-right font-medium">Max</th>
                  <th className="py-1 text-right font-medium">Fails</th>
                </tr>
              </thead>
              <tbody>
                {data.op_stats.map((s) => (
                  <tr key={s.op} className="border-t">
                    <td className="py-1 font-mono">{s.op}</td>
                    <td className="py-1 text-right tabular-nums">{s.count}</td>
                    <td className="py-1 text-right tabular-nums">{s.avg_ms} ms</td>
                    <td
                      className={cn(
                        "py-1 text-right tabular-nums",
                        s.max_ms >= 1000 && "font-semibold text-[var(--color-destructive)]",
                      )}
                    >
                      {s.max_ms} ms
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {s.fail_count > 0 ? (
                        <span className="text-[var(--color-destructive)]">{s.fail_count}</span>
                      ) : (
                        0
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <Divider />
          <div className="mb-1 flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
              Recent errors
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={errorsNewestFirst.length === 0}
                onClick={() => void onCopyAllErrors()}
              >
                Copy all
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={errorsNewestFirst.length === 0}
                onClick={() => void onClearErrors()}
              >
                Clear
              </Button>
            </div>
          </div>
          {errorsNewestFirst.length === 0 ? (
            <p className="text-xs text-[var(--color-muted-foreground)]">No errors recorded.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {errorsNewestFirst.map((entry, i) => (
                <li
                  key={`${entry.at_ms}-${i}`}
                  className="flex items-start justify-between gap-2 border-t pt-1"
                >
                  <div className="min-w-0">
                    <div className="text-[var(--color-muted-foreground)] tabular-nums">
                      {formatTimestampMs(entry.at_ms)}
                    </div>
                    <div className="line-clamp-3 whitespace-pre-wrap break-words font-mono">
                      {entry.message}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    aria-label={`Copy error from ${formatTimestampMs(entry.at_ms)}`}
                    onClick={() => void onCopyErrorRow(entry)}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function DiagRow({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4 py-0.5">
      <span
        className={cn(
          "text-[var(--color-muted-foreground)]",
          danger && "text-[var(--color-destructive)]",
        )}
      >
        {label}
      </span>
      <span className={cn("tabular-nums", danger && "text-[var(--color-destructive)]")}>
        {value}
      </span>
    </div>
  );
}
