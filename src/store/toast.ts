import { create } from "zustand";

import { ipc } from "@/lib/ipc";
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
    if (variant === "error") {
      // The single choke point every error toast passes through (#301) — so
      // capturing here covers the component `<Toast>` path, the imperative
      // `toast.error` helper, and every future error site for free.
      //
      // Capturing must never perturb the toast it observes (the same rule the
      // backend's op-timing recorder follows): the whole block is guarded, and
      // the async rejection is swallowed rather than surfaced. Surfacing it
      // would raise a second error toast and recurse.
      try {
        console.error(message);
        void ipc.recordError(message).catch(() => {});
      } catch {
        // Recording is best-effort; the toast still shows.
      }
    }
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
