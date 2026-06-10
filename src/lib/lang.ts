const LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
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

/** Monaco language id for a file path, by extension. */
export function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANG[ext] ?? "plaintext";
}

/** Whether the current document is in dark mode (for Monaco theming). */
export function isDarkTheme(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  );
}
