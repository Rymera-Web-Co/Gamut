import {
  File,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileText,
  FileType,
  type LucideIcon,
} from "lucide-react";

const BY_EXT: Record<string, LucideIcon> = {
  // code
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  rs: FileCode,
  go: FileCode,
  py: FileCode,
  rb: FileCode,
  php: FileCode,
  java: FileCode,
  kt: FileCode,
  swift: FileCode,
  c: FileCode,
  h: FileCode,
  cpp: FileCode,
  cc: FileCode,
  hpp: FileCode,
  cs: FileCode,
  sh: FileCode,
  bash: FileCode,
  sql: FileCode,
  html: FileCode,
  vue: FileCode,
  svelte: FileCode,
  // data / config
  json: FileJson,
  yml: FileCog,
  yaml: FileCog,
  toml: FileCog,
  ini: FileCog,
  env: FileCog,
  conf: FileCog,
  lock: FileCog,
  // styles
  css: FileType,
  scss: FileType,
  less: FileType,
  // docs
  md: FileText,
  mdx: FileText,
  txt: FileText,
  rst: FileText,
  // images
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  svg: FileImage,
  webp: FileImage,
  ico: FileImage,
  avif: FileImage,
};

const BY_NAME: Record<string, LucideIcon> = {
  dockerfile: FileCog,
  makefile: FileCog,
  ".gitignore": FileCog,
};

/** A Lucide icon for a file, chosen by name then extension. */
export function fileIcon(name: string): LucideIcon {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  return BY_EXT[ext] ?? File;
}
