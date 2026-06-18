/**
 * Condense `git pull` stdout into a one-line toast summary.
 *
 * `git pull` prints a multi-line report — the `Updating <a>..<b>` /
 * `Fast-forward` header, a per-file diffstat, then a totals line. Dumping all of
 * that into a toast makes it oversized and hard to read, so we keep only the
 * high-signal bit: the "already up to date" case, or the diffstat totals line
 * ("N files changed, ..."). Anything we don't recognise falls back to "Pulled".
 */
export function summarizePull(out: string): string {
  const text = out.trim();
  if (!text) return "Pulled";

  // Nothing to pull — git's own message is already short, keep it verbatim.
  if (/^already up[ -]to[ -]date\.?$/im.test(text)) return "Already up to date.";

  // The diffstat totals line, e.g. "3 files changed, 12 insertions(+), 2 deletions(-)".
  const stat = text.match(/^\s*\d+ files? changed.*$/im);
  if (stat) return `Pulled · ${stat[0].trim()}`;

  return "Pulled";
}
