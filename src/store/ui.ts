import { create } from "zustand";

export type View = "repos" | "history" | "review";

interface UiState {
  view: View;
  activeRepoId: number | null;
  setView: (view: View) => void;
  setActiveRepo: (id: number | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: "repos",
  activeRepoId: null,
  setView: (view) => set({ view }),
  setActiveRepo: (id) => set({ activeRepoId: id }),
}));
