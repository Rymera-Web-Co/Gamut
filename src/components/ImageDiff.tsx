import { useState } from "react";

import { formatBytes } from "@/lib/format";
import type { FileDiff } from "@/lib/ipc";

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
            key={src}
            src={src}
            alt={alt}
            onLoad={(e) =>
              setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
            }
            onError={() => setDims(null)}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <span className="text-sm text-[var(--color-muted-foreground)]">
            No preview available (too large or unsupported type).
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
 * files show both side by side. A side that exists but has no `data:` URL
 * (over the size cap, or a non-image extension on one side of a rename) gets an
 * in-place notice instead of an image. Side presence follows `old_text` /
 * `new_text`, which the backend sets to `""` (not `null`) for binary sides. */
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
          alt={`${name} — ${oldLabel}`}
        />
      )}
      {hasNew && (
        <ImageSide
          label={hasOld ? newLabel : `${newLabel} (added)`}
          src={diff.new_image}
          alt={`${name} — ${newLabel}`}
        />
      )}
    </div>
  );
}
