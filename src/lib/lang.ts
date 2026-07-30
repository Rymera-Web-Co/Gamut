const LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  go: "go",
  java: "java",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "html",
  json: "json",
  jsonc: "json",
  json5: "json",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  bash: "shell",
  sql: "sql",
  toml: "ini",
  ini: "ini",
  xml: "xml",
  dockerfile: "dockerfile",
};

/**
 * Files identified by their (case-insensitive) basename rather than an
 * extension — dotfiles whose `.rc` suffix isn't a real extension, and
 * extensionless config files. Checked before the extension table so the
 * canonical `Dockerfile` highlights even though it has no `.dockerfile`
 * extension. Monaco has no Makefile grammar, so `Makefile` falls back to the
 * closest supported (`shell`).
 */
const FILENAME_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "shell",
  gemfile: "ruby",
  rakefile: "ruby",
  ".eslintrc": "json",
  ".babelrc": "json",
  ".prettierrc": "json",
  ".stylelintrc": "json",
  ".npmrc": "ini",
  ".env": "shell",
};

/** Lowercased final path segment, for both of the lookups below. */
function basenameOf(path: string): string {
  return (path.split(/[/\\]/).pop() ?? "").toLowerCase();
}

/** Extension after the last dot in a basename, `""` when there is none. A
 * leading dot (index 0) is a dotfile, not an extension, so require dot > 0. */
function extensionOf(base: string): string {
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

/** Monaco language id for a file path, by basename then extension. */
export function languageFor(path: string): string {
  const base = basenameOf(path);
  // Filename match first: handles dotfiles (`.eslintrc`) and extensionless
  // files (`Dockerfile`) whose trailing dot-segment isn't a useful extension.
  if (FILENAME_LANG[base]) return FILENAME_LANG[base];
  // `.env.local`, `.env.production`, etc. share the `.env` shell-ish syntax.
  if (base.startsWith(".env.")) return "shell";
  return LANG[extensionOf(base)] ?? "plaintext";
}

/**
 * Whether a path is a standalone HTML document — the gate for the Files view's
 * sandboxed HTML preview (#296).
 *
 * Deliberately narrower than `languageFor(path) === "html"`, which also matches
 * `.vue`: a single-file component is *highlighted* as HTML but isn't a document
 * you can render, so it keeps the plain editor with no preview toggle. Keeping
 * this predicate next to the `LANG` table is what stops that distinction from
 * drifting away from a second matcher elsewhere.
 */
export function isHtmlPath(path: string): boolean {
  const ext = extensionOf(basenameOf(path));
  return ext === "html" || ext === "htm";
}

/** Whether the current document is in dark mode (for Monaco theming). */
export function isDarkTheme(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}
