import {
  Box,
  Briefcase,
  Code,
  Database,
  Folder,
  GitBranch,
  Globe,
  Layers,
  Rocket,
  Star,
  Terminal,
  Zap,
  type LucideIcon,
} from "lucide-react";

/** Default icon choices for groups, keyed by the value stored in the DB. */
export const GROUP_ICONS: Record<string, LucideIcon> = {
  folder: Folder,
  "git-branch": GitBranch,
  box: Box,
  layers: Layers,
  rocket: Rocket,
  star: Star,
  code: Code,
  terminal: Terminal,
  database: Database,
  globe: Globe,
  briefcase: Briefcase,
  zap: Zap,
};

export const GROUP_ICON_KEYS = Object.keys(GROUP_ICONS);

/** Two-letter initials fallback when a group has no icon. */
export function groupInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}
