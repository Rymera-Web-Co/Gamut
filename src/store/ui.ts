import { create } from "zustand";

export type View = "history" | "review";

interface UiState {
  view: View;
  activeRepoId: number | null;
  activeGroupId: number | null;
  setView: (view: View) => void;
  setActiveRepo: (id: number | null) => void;
  setActiveGroup: (id: number | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: "history",
  activeRepoId: null,
  activeGroupId: null,
  setView: (view) => set({ view }),
  setActiveRepo: (id) => set({ activeRepoId: id }),
  setActiveGroup: (id) => set({ activeGroupId: id }),
}));
