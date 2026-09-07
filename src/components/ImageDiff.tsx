import { useState } from "react";

import type { FileDiff } from "@/lib/ipc";

/** Human-readable byte size for the caption. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let size = n / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[i]}`;
}

/** Decoded byte length of a base64 `data:` URL (no need to ship a count over IPC). */
function dataUrlBytes(url: string): number {
  const comma = url.indexOf(",");
  const b64 = comma === -1 ? "" : url.slice(comma + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

function ImageSide({ label, src, alt }: { label: string; src: string | null; alt: string }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  return (
    <figure className="flex min-h-0 min-w-0 flex-1 flex-col">
      <figcaption className="shrink-0 border-b px-3 py-1 text-xs font-medium text-[var(--color-muted-foreground)]">
        {label}
      </figcaption>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {src ? (
          <img
            src={src}
            alt={alt}
            onLoad={(e) =>
              setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
            }
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <span className="text-sm text-[var(--color-muted-foreground)]">
            Image too large to preview.
          </span>
        )}
      </div>
      {src && (
        <div className="shrink-0 border-t px-3 py-1 text-center font-mono text-xs text-[var(--color-muted-foreground)]">
          {formatBytes(dataUrlBytes(src))}
          {dims && ` · ${dims.w}×${dims.h}`}
        </div>
      )}
    </figure>
  );
}

/** Old/new preview for an image change, replacing the "Binary file — diff not
 * shown." placeholder. Added and deleted files show a single side; modified
 * files show both side by side. A side that exists but exceeds the preview size
 * cap (no `data:` URL) gets an in-place notice instead of an image. */
export function ImageDiff({
  diff,
  oldLabel = "Before",
  newLabel = "After",
}: {
  diff: FileDiff;
  oldLabel?: string;
  newLabel?: string;
}) {
  const name = diff.path.split("/").pop() ?? diff.path;
  const hasOld = diff.old_text != null;
  const hasNew = diff.new_text != null;
  return (
    <div className="flex h-full min-h-0 divide-x">
      {hasOld && (
        <ImageSide
          label={hasNew ? oldLabel : `${oldLabel} (deleted)`}
          src={diff.old_image}
          alt={`${name} — ${oldLabel.toLowerCase()}`}
        />
      )}
      {hasNew && (
        <ImageSide
          label={hasOld ? newLabel : `${newLabel} (added)`}
          src={diff.new_image}
          alt={`${name} — ${newLabel.toLowerCase()}`}
        />
      )}
    </div>
  );
}
