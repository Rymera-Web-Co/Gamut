import { MutationCache, QueryClient } from "@tanstack/react-query";

import { toast } from "@/store/toast";

export const queryClient = new QueryClient({
  // Surface mutation failures (checkout, review submit, tag edits, …) as toasts.
  mutationCache: new MutationCache({
    onError: (error) => toast.error(String(error)),
  }),
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});
