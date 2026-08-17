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

/**
 * Deterministic per-group identity colour, derived from the name so it is
 * stable without a schema change. The chip renders white glyphs on this
 * colour, so lightness is hue-banded: yellow-green-cyan hues (which are far
 * brighter at equal HSL lightness) drop to 30% so white text holds ≥4.5:1 at
 * every hue (measured worst case 4.75:1 at hue 60).
 */
export function groupColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  const lightness = hue > 15 && hue < 215 ? 30 : 46;
  return `hsl(${hue} 55% ${lightness}%)`;
}
