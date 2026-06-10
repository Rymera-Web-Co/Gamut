import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";

const keys = {
  repos: ["repos"] as const,
  groups: ["groups"] as const,
};

export function useRepos() {
  return useQuery({ queryKey: keys.repos, queryFn: ipc.listRepos });
}

export function useGroups() {
  return useQuery({ queryKey: keys.groups, queryFn: ipc.listGroups });
}

export function useRepoStatuses() {
  return useQuery({
    queryKey: ["repo-statuses"],
    queryFn: ipc.repoStatuses,
    staleTime: 30_000,
  });
}

/** Invalidate everything the sidebar tree depends on. */
function useInvalidateTree() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: keys.repos });
    qc.invalidateQueries({ queryKey: keys.groups });
  };
}

export function useRegisterRepo() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (path: string) => ipc.registerRepo(path),
    onSuccess: invalidate,
  });
}

export function useRemoveRepo() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (id: number) => ipc.removeRepo(id),
    onSuccess: invalidate,
  });
}

export function useCreateGroup() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: ({ name, icon }: { name: string; icon: string | null }) =>
      ipc.createGroup(name, icon),
    onSuccess: invalidate,
  });
}

export function useUpdateGroup() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: ({
      id,
      name,
      icon,
    }: {
      id: number;
      name: string | null;
      icon: string | null;
    }) => ipc.updateGroup(id, name, icon),
    onSuccess: invalidate,
  });
}

export function useDeleteGroup() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (id: number) => ipc.deleteGroup(id),
    onSuccess: invalidate,
  });
}

export function useReorderRepos() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (repoIds: number[]) => ipc.reorderRepos(repoIds),
    onSuccess: invalidate,
  });
}

export function useReorderGroups() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (groupIds: number[]) => ipc.reorderGroups(groupIds),
    onSuccess: invalidate,
  });
}

export function useSetRepoGroups() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: ({ repoId, groupIds }: { repoId: number; groupIds: number[] }) =>
      ipc.setRepoGroups(repoId, groupIds),
    onSuccess: invalidate,
  });
}
