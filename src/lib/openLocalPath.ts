import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { ipc, type ResolvedTermPath } from "@/lib/ipc";
import { isImagePath } from "@/lib/images";
import { useUiStore } from "@/store/ui";

/**
 * File types the in-app editor can't render usefully — revealed in the OS file
 * manager even when they live inside a tracked repo (#255, #344). Images are
 * absent because the in-app viewer handles them.
 */
const OPAQUE_EXTS = new Set([
  "pdf",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "tar",
  "exe",
  "dmg",
  "pkg",
  "app",
  "deb",
  "rpm",
  "msi",
  "bin",
  "iso",
  "so",
  "dylib",
  "dll",
  "o",
  "a",
  "class",
  "jar",
  "war",
  "wasm",
  "mp3",
  "wav",
  "flac",
  "aac",
  "ogg",
  "m4a",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "m4v",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "sqlite",
  "db",
]);

/** Lowercased extension of a `/`-separated path, or "" when it has none. */
function extOf(p: string): string {
  const base = p.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Whether an in-repo file should open in the in-app editor rather than the OS. */
function opensInApp(relPath: string): boolean {
  if (isImagePath(relPath)) return true; // in-app image viewer
  return !OPAQUE_EXTS.has(extOf(relPath));
}

/**
 * Route a resolved local path to where the user expects it (#255, #344): an
 * in-repo text file / image opens in the in-app Files editor; anything else — a
 * directory, an in-repo binary (`OPAQUE_EXTS`), or any file outside every
 * tracked repo — is revealed in the OS file manager. Nothing is handed to the
 * OS default app, which is often the wrong target (or runs the file, for a
 * script or an installer).
 */
export function openResolvedPath(resolved: ResolvedTermPath) {
  const { abs_path, is_dir, repo_id, rel_path } = resolved;
  if (!is_dir && repo_id != null && rel_path != null && opensInApp(rel_path)) {
    // `setActiveRepo` resets the open file, so `setFilesPath` (consumed after
    // it) must run last — the same order the control-channel `open` deep-link
    // uses.
    const ui = useUiStore.getState();
    ui.setActiveRepo(repo_id);
    ui.showView("files");
    ui.setFilesPath(rel_path);
    return;
  }
  // Expanding an in-repo directory in the Files tree is a follow-up — no
  // deep-link exists for it yet.
  revealItemInDir(abs_path).catch(() => {});
}

/**
 * Resolve a local path and open it per {@link openResolvedPath}. The backend
 * expands `~`, resolves a relative `path` against `cwd` and canonicalizes it. A
 * path that doesn't exist (or fails to resolve) leaves the click inert.
 */
export async function openLocalPath(path: string, cwd: string) {
  let resolved: ResolvedTermPath | null;
  try {
    resolved = await ipc.resolveTerminalPath(path, cwd);
  } catch {
    return;
  }
  if (resolved) openResolvedPath(resolved);
}

/**
 * The filesystem path a link `href` points at, or `null` when it isn't a local
 * file link (a web/`mailto:` URL, a fragment-only `#heading`, an empty href).
 *
 * Accepts a `file:` URL, an absolute or `~` path, a Windows drive path, or a
 * relative path (resolved later against the linking file's directory). A
 * `#fragment` or `?query` suffix is dropped and percent-escapes are decoded, so
 * `docs/My%20Notes.md#setup` yields `docs/My Notes.md`.
 */
export function localLinkPath(href: string): string | null {
  const raw = href.trim();
  if (raw === "" || raw.startsWith("#") || raw.startsWith("//")) return null;
  if (/^file:/i.test(raw)) {
    try {
      const pathname = decodeURIComponent(new URL(raw).pathname);
      // `file:///C:/x` parses to `/C:/x`; drop the slash before a drive letter.
      const path = /^\/[A-Za-z]:/.test(pathname) ? pathname.slice(1) : pathname;
      return path === "" ? null : path;
    } catch {
      return null;
    }
  }
  // Any other scheme (`https:`, `mailto:`, …) is not a local file. A single
  // letter before the colon is a Windows drive (`C:\x`, `C:/x`), not a scheme.
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(raw)) return null;
  const path = raw.replace(/[?#].*$/, "");
  if (path === "") return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return path; // a stray `%` — use the text as written
  }
}

/**
 * Local-link base for a repo Markdown preview (#344): the absolute directory of
 * the open file, so a relative link resolves the way GitHub resolves it.
 * `undefined` until both the repo path and the open file are known.
 */
export function markdownLinkBase(
  repoPath: string | undefined,
  relPath: string | null,
): { baseDir: string } | undefined {
  if (repoPath == null || relPath == null) return undefined;
  const slash = relPath.lastIndexOf("/");
  const dir = slash > 0 ? relPath.slice(0, slash) : "";
  const root = repoPath.replace(/[\\/]+$/, "");
  return { baseDir: dir ? `${root}/${dir}` : root };
}
