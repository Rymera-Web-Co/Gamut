import { useQuery } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";

export function useLog(repoId: number | null, limit: number) {
  return useQuery({
    queryKey: ["log", repoId, limit],
    queryFn: () => ipc.log(repoId!, 0, limit),
    enabled: repoId != null,
    placeholderData: (prev) => prev, // keep prior page while loading more
  });
}

export function useCommitDetail(repoId: number | null, sha: string | null) {
  return useQuery({
    queryKey: ["commit", repoId, sha],
    queryFn: () => ipc.commitDetail(repoId!, sha!),
    enabled: repoId != null && sha != null,
  });
}

// Resolve a commit author's GitHub avatar. Keyed by email (not sha) so every
// commit by the same author shares one query in-session, matching the backend's
// email-keyed persistent cache (#195); the backend result is already durable, so
// there's no reason to ever consider it stale within a session.
export function useCommitAvatar(repoId: number | null, sha: string | null, email: string | null) {
  return useQuery({
    queryKey: ["commit-avatar", email],
    queryFn: () => ipc.githubCommitAvatar(repoId!, sha!, email!),
    enabled: repoId != null && sha != null && !!email,
    staleTime: Infinity,
  });
}

export function useFileDiff(
  repoId: number | null,
  sha: string | null,
  path: string | null,
  oldPath?: string | null,
) {
  return useQuery({
    queryKey: ["file-diff", repoId, sha, path],
    queryFn: () => ipc.fileDiff(repoId!, sha!, path!, oldPath ?? undefined),
    enabled: repoId != null && sha != null && path != null,
  });
}

export function useBlame(
  repoId: number | null,
  sha: string | null,
  path: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["blame", repoId, sha, path],
    queryFn: () => ipc.blame(repoId!, sha!, path!),
    enabled: enabled && repoId != null && sha != null && path != null,
  });
}
