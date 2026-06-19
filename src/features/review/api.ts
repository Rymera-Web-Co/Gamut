import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ipc,
  type BodyTarget,
  type DraftComment,
  type MergeMethod,
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
    queryFn: () => ipc.reviewFileDiff(repoId!, source, path!, undefined, oldPath ?? undefined),
    enabled: repoId != null && path != null,
  });
}

// ---- Working tree: staging / commit / stash ----

export function useWorktreeStatus(repoId: number | null) {
  return useQuery({
    queryKey: ["worktree-status", repoId],
    queryFn: () => ipc.worktreeStatus(repoId!),
    enabled: repoId != null,
  });
}

export function useWorktreeFileDiff(
  repoId: number | null,
  path: string | null,
  staged: boolean,
  oldPath?: string | null,
) {
  return useQuery({
    queryKey: ["worktree-file-diff", repoId, path, staged],
    queryFn: () => ipc.worktreeFileDiff(repoId!, path!, staged, oldPath ?? undefined),
    enabled: repoId != null && path != null,
  });
}

export function useStashList(repoId: number | null) {
  return useQuery({
    queryKey: ["stash-list", repoId],
    queryFn: () => ipc.gitStashList(repoId!),
    enabled: repoId != null,
  });
}

/** Refresh everything a staging/commit/stash action can affect. */
function useInvalidateWorktree(repoId: number) {
  const qc = useQueryClient();
  return () => {
    for (const key of [
      "worktree-status",
      "worktree-file-diff",
      "review-files",
      "stash-list",
      "log",
      "branches",
      "sync-status",
      // Files tab: discarding/committing can change file contents on disk and
      // the set of files present, so refresh its listings and open file too.
      "file",
      "dir",
    ]) {
      qc.invalidateQueries({ queryKey: [key, repoId] });
    }
    qc.invalidateQueries({ queryKey: ["repo-statuses"] });
  };
}

export function useStage(repoId: number) {
  const invalidate = useInvalidateWorktree(repoId);
  return useMutation({
    mutationFn: (paths: string[]) => ipc.gitStage(repoId, paths),
    onSuccess: invalidate,
  });
}

export function useUnstage(repoId: number) {
  const invalidate = useInvalidateWorktree(repoId);
  return useMutation({
    mutationFn: (paths: string[]) => ipc.gitUnstage(repoId, paths),
    onSuccess: invalidate,
  });
}

export function useDiscard(repoId: number) {
  const invalidate = useInvalidateWorktree(repoId);
  return useMutation({
    mutationFn: (paths: string[]) => ipc.gitDiscard(repoId, paths),
    onSuccess: invalidate,
  });
}

export function useCommit(repoId: number) {
  const invalidate = useInvalidateWorktree(repoId);
  return useMutation({
    mutationFn: (message: string) => ipc.gitCommit(repoId, message),
    onSuccess: invalidate,
  });
}

export function useStashPush(repoId: number) {
  const invalidate = useInvalidateWorktree(repoId);
  return useMutation({
    mutationFn: ({
      message,
      includeUntracked,
    }: {
      message: string | null;
      includeUntracked: boolean;
    }) => ipc.gitStashPush(repoId, message, includeUntracked),
    onSuccess: invalidate,
  });
}

export function useStashAction(repoId: number, action: "pop" | "apply" | "drop") {
  const invalidate = useInvalidateWorktree(repoId);
  const fn = {
    pop: ipc.gitStashPop,
    apply: ipc.gitStashApply,
    drop: ipc.gitStashDrop,
  }[action];
  return useMutation({
    mutationFn: (index: number) => fn(repoId, index),
    onSuccess: invalidate,
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

/** PR timeline events (commits, review requests, cross-references, labels, …). */
export function usePrTimeline(repoId: number | null, number: number | null) {
  return useQuery({
    queryKey: ["github-pr-timeline", repoId, number],
    queryFn: () => ipc.githubPrTimeline(repoId!, number!),
    enabled: repoId != null && number != null,
  });
}

/** Read-only PR sidebar metadata (reviewers, assignees, labels, milestone, links). */
export function usePrDetails(repoId: number, number: number | null) {
  return useQuery({
    queryKey: ["github-pr-details", repoId, number],
    queryFn: () => ipc.githubPrDetails(repoId, number!),
    enabled: number != null,
  });
}

export function useMergePr(repoId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ number, method }: { number: number; method: MergeMethod }) =>
      ipc.githubMergePr(repoId, number, method),
    onSuccess: (_d, { number }) => {
      qc.invalidateQueries({ queryKey: ["github-prs", repoId] });
      qc.invalidateQueries({ queryKey: ["github-pr-thread", repoId, number] });
    },
  });
}

/** Inline review-comment threads (grouped comments + replies + resolved state). */
export function useReviewThreads(repoId: number, number: number | null) {
  return useQuery({
    queryKey: ["github-review-threads", repoId, number],
    queryFn: () => ipc.githubReviewThreads(repoId, number!),
    enabled: number != null,
  });
}

export function useReplyReviewComment(repoId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      number,
      commentId,
      body,
    }: {
      number: number;
      commentId: number;
      body: string;
    }) => ipc.githubReplyReviewComment(repoId, number, commentId, body),
    onSuccess: (_d, { number }) =>
      qc.invalidateQueries({
        queryKey: ["github-review-threads", repoId, number],
      }),
  });
}

export function useResolveThread(repoId: number, number: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, resolved }: { threadId: string; resolved: boolean }) =>
      ipc.githubResolveThread(threadId, resolved),
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["github-review-threads", repoId, number],
      }),
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

/** Local + remote branches for the repo (to tell if a PR branch is checked out). */
export function useBranches(repoId: number | null) {
  return useQuery({
    queryKey: ["branches", repoId],
    queryFn: () => ipc.listBranches(repoId!),
    enabled: repoId != null,
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
      commitId,
      comments,
    }: {
      number: number;
      event: ReviewEvent;
      body: string;
      commitId?: string | null;
      comments?: DraftComment[];
    }) => ipc.githubSubmitReview(repoId, number, event, body, commitId, comments),
    onSuccess: (_data, { number }) => {
      qc.invalidateQueries({ queryKey: ["github-prs", repoId] });
      qc.invalidateQueries({ queryKey: ["github-pr-thread", repoId, number] });
    },
  });
}

/** Post a single inline review comment immediately (the "Comment" action). */
export function usePrComment(repoId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      number,
      commitId,
      comment,
    }: {
      number: number;
      commitId: string;
      comment: DraftComment;
    }) => ipc.githubPrComment(repoId, number, commitId, comment),
    onSuccess: (_data, { number }) => {
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
              : prev.comments.map((c) => (c.id === id ? { ...c, body } : c)),
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
