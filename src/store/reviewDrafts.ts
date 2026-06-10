import { create } from "zustand";

import type { DraftComment } from "@/lib/ipc";

/** A pending inline comment, kept client-side until the review is submitted. */
export interface Draft extends DraftComment {
  id: number;
}

interface DraftsState {
  // Keyed by `${repoId}:${prNumber}`.
  byPr: Record<string, Draft[]>;
  seq: number;
  add: (repoId: number, number: number, comment: DraftComment) => void;
  remove: (repoId: number, number: number, id: number) => void;
  clear: (repoId: number, number: number) => void;
}

const key = (repoId: number, number: number) => `${repoId}:${number}`;

export const useReviewDrafts = create<DraftsState>((set) => ({
  byPr: {},
  seq: 1,
  add: (repoId, number, comment) =>
    set((s) => {
      const k = key(repoId, number);
      const id = s.seq;
      return {
        seq: s.seq + 1,
        byPr: { ...s.byPr, [k]: [...(s.byPr[k] ?? []), { ...comment, id }] },
      };
    }),
  remove: (repoId, number, id) =>
    set((s) => {
      const k = key(repoId, number);
      return {
        byPr: { ...s.byPr, [k]: (s.byPr[k] ?? []).filter((d) => d.id !== id) },
      };
    }),
  clear: (repoId, number) =>
    set((s) => {
      const next = { ...s.byPr };
      delete next[key(repoId, number)];
      return { byPr: next };
    }),
}));

/** Select the pending drafts for a PR (stable empty array when none). */
const EMPTY: Draft[] = [];
export function useDraftsFor(repoId: number, number: number) {
  return useReviewDrafts((s) => s.byPr[key(repoId, number)] ?? EMPTY);
}
