/** dataTransfer MIME types used for in-app drag and drop. */
export const DND_REPO = "application/x-gamut-repo";
export const DND_GROUP = "application/x-gamut-group";

/** Return a new array with `srcId` moved to just before `targetId`. */
export function moveBefore<T>(items: T[], srcId: T, targetId: T): T[] {
  if (srcId === targetId) return items;
  const without = items.filter((x) => x !== srcId);
  const idx = without.indexOf(targetId);
  if (idx === -1) return items;
  without.splice(idx, 0, srcId);
  return without;
}
