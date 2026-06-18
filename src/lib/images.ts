/** Image extensions the file editor can preview inline. Mirrors
 * `ALLOWED_IMAGE_EXTS` in `src-tauri/src/commands/files.rs` — the backend is the
 * authoritative guard; this is the UI-side check that picks the image renderer. */
export const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
  "avif",
];

/** Whether a path points at an image we can preview, judged by extension. */
export function isImagePath(path: string): boolean {
  const lower = path.toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  return IMAGE_EXTENSIONS.includes(ext);
}
