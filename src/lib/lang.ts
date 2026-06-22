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

/** Monaco language id for a file path, by basename then extension. */
export function languageFor(path: string): string {
  const base = (path.split(/[/\\]/).pop() ?? "").toLowerCase();
  // Filename match first: handles dotfiles (`.eslintrc`) and extensionless
  // files (`Dockerfile`) whose trailing dot-segment isn't a useful extension.
  if (FILENAME_LANG[base]) return FILENAME_LANG[base];
  // `.env.local`, `.env.production`, etc. share the `.env` shell-ish syntax.
  if (base.startsWith(".env.")) return "shell";
  // Otherwise resolve by the extension after the last dot in the basename. A
  // leading dot (index 0) is a dotfile, not an extension, so require dot > 0.
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1) : "";
  return LANG[ext] ?? "plaintext";
}

/** Whether the current document is in dark mode (for Monaco theming). */
export function isDarkTheme(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}
