import { create } from "zustand";

export type View = "history" | "review" | "pulls";
export type ReviewMode = "working" | "branch";

interface UiState {
  view: View;
  reviewMode: ReviewMode;
  activeRepoId: number | null;
  activeGroupId: number | null;
  selectedPrNumber: number | null;
  setView: (view: View) => void;
  setReviewMode: (mode: ReviewMode) => void;
  setActiveRepo: (id: number | null) => void;
  setActiveGroup: (id: number | null) => void;
  setSelectedPr: (n: number | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: "history",
  reviewMode: "working",
  activeRepoId: null,
  activeGroupId: null,
  selectedPrNumber: null,
  setView: (view) => set({ view }),
  setReviewMode: (reviewMode) => set({ reviewMode }),
  // Reset the selected PR when switching repos — it's repo-specific.
  setActiveRepo: (id) => set({ activeRepoId: id, selectedPrNumber: null }),
  setActiveGroup: (id) => set({ activeGroupId: id }),
  setSelectedPr: (selectedPrNumber) => set({ selectedPrNumber }),
}));
