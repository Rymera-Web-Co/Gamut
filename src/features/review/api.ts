import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  ipc,
  type BodyTarget,
  type PrThread,
  type ReviewEvent,
  type ReviewSource,
} from "@/lib/ipc";

// ---- Local self-review ----

export function useReviewFiles(repoId: number | null, source: ReviewSource) {
  return useQuery({
    queryKey: ["review-files", repoId, source],
    queryFn: () => ipc.reviewFiles(repoId!, source),
    enabled: repoId != null,
  });
}

export function useReviewFileDiff(
  repoId: number | null,
  source: ReviewSource,
  path: string | null,
  oldPath?: string | null,
) {
  return useQuery({
    queryKey: ["review-file-diff", repoId, source, path],
    queryFn: () =>
      ipc.reviewFileDiff(repoId!, source, path!, undefined, oldPath ?? undefined),
    enabled: repoId != null && path != null,
  });
}

// ---- GitHub ----

export function useGithubAuth() {
  return useQuery({
    queryKey: ["github-auth"],
    queryFn: ipc.githubAuthStatus,
    staleTime: 5 * 60_000,
  });
}

export function useSetToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => ipc.githubSetToken(token),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["github-auth"] }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => ipc.githubLogout(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["github-auth"] }),
  });
}

export function useGithubPrs(repoId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: ["github-prs", repoId],
    queryFn: () => ipc.githubListPrs(repoId!),
    enabled: enabled && repoId != null,
    retry: false,
  });
}

export function useGithubPrDiff(repoId: number | null, number: number | null) {
  return useQuery({
    queryKey: ["github-pr-diff", repoId, number],
    queryFn: () => ipc.githubPrDiff(repoId!, number!),
    enabled: repoId != null && number != null,
  });
}

export function usePrThread(repoId: number | null, number: number | null) {
  return useQuery({
    queryKey: ["github-pr-thread", repoId, number],
    queryFn: () => ipc.githubPrThread(repoId!, number!),
    enabled: repoId != null && number != null,
  });
}

/** Users that can be @-mentioned in this repo (its assignable collaborators). */
export function useMentionables(repoId: number, enabled: boolean) {
  return useQuery({
    queryKey: ["github-mentionables", repoId],
    queryFn: () => ipc.githubMentionables(repoId),
    enabled: enabled && repoId != null,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

export function useCheckoutPr(repoId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ number, headRef }: { number: number; headRef: string }) =>
      ipc.gitCheckoutPr(repoId, number, headRef),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["branches", repoId] });
      qc.invalidateQueries({ queryKey: ["log", repoId] });
      qc.invalidateQueries({ queryKey: ["review-files", repoId] });
      qc.invalidateQueries({ queryKey: ["sync-status", repoId] });
      qc.invalidateQueries({ queryKey: ["repo-statuses"] });
    },
  });
}

export function useSubmitReview(repoId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      number,
      event,
      body,
    }: {
      number: number;
      event: ReviewEvent;
      body: string;
    }) => ipc.githubSubmitReview(repoId, number, event, body),
    onSuccess: (_data, { number }) => {
      qc.invalidateQueries({ queryKey: ["github-prs", repoId] });
      qc.invalidateQueries({ queryKey: ["github-pr-thread", repoId, number] });
    },
  });
}

/**
 * Edit the body of the PR description, an issue comment, or a review — used to
 * persist task-list checkbox toggles. Optimistically patches the cached thread
 * so the checkbox flips instantly, reverting if GitHub rejects the edit.
 */
export function useUpdateBody(repoId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      number,
      target,
      id,
      body,
    }: {
      number: number;
      target: BodyTarget;
      id: number | null;
      body: string;
    }) => ipc.githubUpdateBody(repoId, number, target, id, body),
    onMutate: async ({ number, target, id, body }) => {
      const key = ["github-pr-thread", repoId, number];
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<PrThread>(key);
      if (prev) {
        qc.setQueryData<PrThread>(key, {
          ...prev,
          body: target === "pr" ? body : prev.body,
          comments:
            target === "pr"
              ? prev.comments
              : prev.comments.map((c) =>
                  c.id === id ? { ...c, body } : c,
                ),
        });
      }
      return { key, prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: (_data, _err, { number }) => {
      qc.invalidateQueries({ queryKey: ["github-pr-thread", repoId, number] });
    },
  });
}
