import { create } from "zustand";

import { toastTimeout } from "@/lib/settings";

export interface Toast {
  id: number;
  message: string;
  variant: "error" | "success" | "info";
}

interface ToastState {
  toasts: Toast[];
  push: (message: string, variant?: Toast["variant"]) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (message, variant = "info") => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, variant }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, toastTimeout());
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Imperative helper for non-component code (e.g. query client callbacks). */
export const toast = {
  error: (m: string) => useToasts.getState().push(m, "error"),
  success: (m: string) => useToasts.getState().push(m, "success"),
  info: (m: string) => useToasts.getState().push(m, "info"),
};
