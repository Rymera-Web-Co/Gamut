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
import { useSettings } from "@/lib/settings";
import { toast } from "@/store/toast";

// ---- Local self-review ----

export function useReviewFiles(repoId: number | null, source: ReviewSource, base?: string) {
  return useQuery({
    queryKey: ["review-files", repoId, source, base ?? null],
    queryFn: () => ipc.reviewFiles(repoId!, source, base),
    enabled: repoId != null,
  });
}

export function useReviewFileDiff(
  repoId: number | null,
  source: ReviewSource,
  path: string | null,
  base?: string,
  oldPath?: string | null,
) {
  return useQuery({
    queryKey: ["review-file-diff", repoId, source, path, base ?? null],
    queryFn: () => ipc.reviewFileDiff(repoId!, source, path!, base, oldPath ?? undefined),
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

/** Read-only PR sidebar metadata (reviewers, assignees, labels, milestone, links,
 * and the roll-up merge requirements). GitHub computes `mergeable` /
 * `mergeStateStatus` asynchronously, so while either is still UNKNOWN we poll a
 * few seconds apart until it settles, then stop (#185). */
export function usePrDetails(repoId: number, number: number | null) {
  return useQuery({
    queryKey: ["github-pr-details", repoId, number],
    queryFn: () => ipc.githubPrDetails(repoId, number!),
    enabled: number != null,
    refetchInterval: (query) => {
      const m = query.state.data?.merge;
      return m && (m.mergeable === "UNKNOWN" || m.merge_state_status === "UNKNOWN") ? 3000 : false;
    },
  });
}

export function useMergePr(repoId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ number, method }: MergePrVars) => ipc.githubMergePr(repoId, number, method),
    onSuccess: async (_d, { number, baseRef, headRef }) => {
      qc.invalidateQueries({ queryKey: ["github-prs", repoId] });
      qc.invalidateQueries({ queryKey: ["github-pr-thread", repoId, number] });
      await postMergeCleanup(qc, repoId, baseRef, headRef);
    },
  });
}

interface MergePrVars {
  number: number;
  method: MergeMethod;
  /** PR base/head branches, for optional post-merge cleanup (#132). */
  baseRef?: string;
  headRef?: string;
}

interface DraftStateVars {
  /** PR number, for query invalidation on success. */
  number: number;
  /** The PR's GraphQL node id, which the mutation acts on. */
  pullRequestId: string;
}

/** Refresh the PR list, detail, and thread after a draft-state change (#288) so
 * the list badge, merge box, and merge-button gating all reflect the new state. */
function invalidateDraftState(
  qc: ReturnType<typeof useQueryClient>,
  repoId: number,
  number: number,
) {
  qc.invalidateQueries({ queryKey: ["github-prs", repoId] });
  qc.invalidateQueries({ queryKey: ["github-pr-details", repoId, number] });
  qc.invalidateQueries({ queryKey: ["github-pr-thread", repoId, number] });
}

/** Flip a draft PR to "ready for review" (#288). */
export function useMarkReady(repoId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pullRequestId }: DraftStateVars) => ipc.githubMarkPrReady(pullRequestId),
    onSuccess: (_d, { number }) => invalidateDraftState(qc, repoId, number),
  });
}

/** Convert an open PR back to a draft (#288). */
export function useConvertToDraft(repoId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pullRequestId }: DraftStateVars) => ipc.githubConvertPrToDraft(pullRequestId),
    onSuccess: (_d, { number }) => invalidateDraftState(qc, repoId, number),
  });
}

/**
 * Best-effort post-merge cleanup (#132): when enabled, check out the PR's base
 * branch and delete the merged local head branch — but only if GitHub already
 * deleted the remote head branch. Never throws: the merge already succeeded, so
 * any failure here surfaces as a non-fatal toast instead of failing the merge.
 */
/**
 * Whether the remote head branch is still there after a merge. GitHub's
 * auto-delete is asynchronous, so we re-check a few times with backoff
 * (~0s, 1s, 2s, 3s — up to ~6s) and return `false` as soon as it's gone. Only a
 * branch that survives the whole window is treated as genuinely kept (#132).
 */
async function remoteBranchPersists(repoId: number, headRef: string): Promise<boolean> {
  const delays = [1000, 2000, 3000];
  for (let attempt = 0; ; attempt++) {
    if (!(await ipc.githubRemoteBranchExists(repoId, headRef))) return false;
    if (attempt >= delays.length) return true;
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
  }
}

async function postMergeCleanup(
  qc: ReturnType<typeof useQueryClient>,
  repoId: number,
  baseRef?: string,
  headRef?: string,
) {
  if (!useSettings.getState().values.autoCleanupAfterMerge) return;
  if (!baseRef || !headRef || baseRef === headRef) return;
  try {
    await ipc.checkoutBranch(repoId, baseRef);
    // Only drop the local branch if GitHub deleted the remote head branch
    // (its "Automatically delete head branches" setting); otherwise keep it.
    // GitHub deletes the head branch *asynchronously* after the merge call
    // returns, so the ref can linger a second or two — poll with backoff before
    // concluding it's being kept (#132).
    const remoteExists = await remoteBranchPersists(repoId, headRef);
    if (!remoteExists) {
      // delete_branches refuses protected/current branches, reporting per-branch.
      const results = await ipc.deleteBranches(repoId, [headRef]);
      const failed = results.find((r) => !r.deleted && r.error);
      if (failed)
        toast.error(`Merged. Checked out ${baseRef}, but kept ${headRef}: ${failed.error}`);
      else toast.success(`Checked out ${baseRef} and deleted ${headRef}`);
    } else {
      toast.info(`Checked out ${baseRef}; ${headRef} still exists on the remote, kept locally`);
    }
    qc.invalidateQueries({ queryKey: ["branches", repoId] });
    qc.invalidateQueries({ queryKey: ["log", repoId], refetchType: "all" });
    qc.invalidateQueries({ queryKey: ["review-files", repoId] });
    qc.invalidateQueries({ queryKey: ["repo-statuses"] });
  } catch (e) {
    toast.error(`Pull request merged, but post-merge cleanup failed: ${String(e)}`);
  }
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

/** Repo collaborators (login + avatar), for the reviewers/assignees pickers
 * (#334). Loads lazily — `enabled` gates it on the picker popover being open. */
export function useCollaborators(repoId: number, enabled: boolean) {
  return useQuery({
    queryKey: ["github-collaborators", repoId],
    queryFn: () => ipc.githubCollaborators(repoId),
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

/**
 * Shared shape of the reviewer/assignee mutations (#334): each one takes the PR
 * number plus a list of logins, and each one invalidates the same trio of
 * queries afterwards (PR details, the PR thread, and the repo's PR list).
 * Factored out so the four hooks below cannot drift apart.
 */
function usePeopleMutation<V extends { number: number }>(
  repoId: number,
  mutationFn: (vars: V) => Promise<void>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (_data: void, { number }: V) => {
      qc.invalidateQueries({ queryKey: ["github-pr-details", repoId, number] });
      qc.invalidateQueries({ queryKey: ["github-pr-thread", repoId, number] });
      qc.invalidateQueries({ queryKey: ["github-prs", repoId] });
    },
  });
}

/**
 * Request (or re-request) a review from one or more reviewers (#172). On success
 * the PR detail + timeline queries are invalidated so the re-requested indicator
 * and timeline reflect the new state.
 */
export function useRequestReview(repoId: number) {
  return usePeopleMutation(
    repoId,
    ({ number, reviewers }: { number: number; reviewers: string[] }) =>
      ipc.githubRequestReview(repoId, number, reviewers),
  );
}

/**
 * Remove a pending review request from one or more reviewers (#334) — the
 * inverse of `useRequestReview`, used when unchecking a reviewer with an
 * outstanding request in the reviewers picker.
 */
export function useRemoveReviewRequest(repoId: number) {
  return usePeopleMutation(
    repoId,
    ({ number, reviewers }: { number: number; reviewers: string[] }) =>
      ipc.githubRemoveReviewRequest(repoId, number, reviewers),
  );
}

/** Add one or more assignees to a PR (#334), from the assignees picker. */
export function useAddAssignees(repoId: number) {
  return usePeopleMutation(
    repoId,
    ({ number, assignees }: { number: number; assignees: string[] }) =>
      ipc.githubAddAssignees(repoId, number, assignees),
  );
}

/** Remove one or more assignees from a PR (#334), from the assignees picker. */
export function useRemoveAssignees(repoId: number) {
  return usePeopleMutation(
    repoId,
    ({ number, assignees }: { number: number; assignees: string[] }) =>
      ipc.githubRemoveAssignees(repoId, number, assignees),
  );
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
