import { useState } from "react";
import { Loader2 } from "lucide-react";

import { useImageFile } from "./api";

/** Human-readable byte size for the preview caption. */
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

/** Inline preview for an image file: the image scaled to fit the pane, with a
 * caption showing its name, on-disk size, and pixel dimensions. Replaces the
 * "Binary file — not shown." placeholder for supported image types. */
export function ImageView({
  repoId,
  path,
}: {
  repoId: number;
  path: string;
}) {
  const image = useImageFile(repoId, path);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const name = path.split("/").pop() ?? path;

  if (image.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="animate-spin text-[var(--color-muted-foreground)]" />
      </div>
    );
  }
  if (image.isError) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-[var(--color-destructive)]">
        {String(image.error)}
      </div>
    );
  }
  if (!image.data) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img
          src={image.data.data_url}
          alt={name}
          onLoad={(e) =>
            setDims({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            })
          }
          className="max-h-full max-w-full object-contain"
        />
      </div>
      <div className="shrink-0 border-t px-4 py-1.5 text-center font-mono text-xs text-[var(--color-muted-foreground)]">
        {name} · {formatBytes(image.data.byte_len)}
        {dims && ` · ${dims.w}×${dims.h}`}
      </div>
    </div>
  );
}
