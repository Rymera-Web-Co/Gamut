import { create } from "zustand";

export type View = "history" | "review" | "pulls";
export type ReviewMode = "working" | "branch";

const REPO_SIDEBAR_KEY = "gamut.repoSidebarHidden";

function storedRepoSidebarHidden(): boolean {
  return localStorage.getItem(REPO_SIDEBAR_KEY) === "1";
}

interface UiState {
  view: View;
  reviewMode: ReviewMode;
  activeRepoId: number | null;
  activeGroupId: number | null;
  selectedPrNumber: number | null;
  // Whether the repo sidebar column is hidden. Persisted to localStorage.
  repoSidebarHidden: boolean;
  // One-shot navigation target: a commit to reveal in the History tab. The
  // History view consumes it (selects + scrolls to it) and clears it.
  historySha: string | null;
  setView: (view: View) => void;
  setReviewMode: (mode: ReviewMode) => void;
  setActiveRepo: (id: number | null) => void;
  setActiveGroup: (id: number | null) => void;
  setSelectedPr: (n: number | null) => void;
  setHistorySha: (sha: string | null) => void;
  toggleRepoSidebar: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  view: "history",
  reviewMode: "working",
  activeRepoId: null,
  activeGroupId: null,
  selectedPrNumber: null,
  repoSidebarHidden: storedRepoSidebarHidden(),
  historySha: null,
  setView: (view) => set({ view }),
  setReviewMode: (reviewMode) => set({ reviewMode }),
  // Reset the selected PR when switching repos — it's repo-specific.
  setActiveRepo: (id) => set({ activeRepoId: id, selectedPrNumber: null }),
  setActiveGroup: (id) => set({ activeGroupId: id }),
  setSelectedPr: (selectedPrNumber) => set({ selectedPrNumber }),
  setHistorySha: (historySha) => set({ historySha }),
  toggleRepoSidebar: () => {
    const repoSidebarHidden = !get().repoSidebarHidden;
    localStorage.setItem(REPO_SIDEBAR_KEY, repoSidebarHidden ? "1" : "0");
    set({ repoSidebarHidden });
  },
}));
