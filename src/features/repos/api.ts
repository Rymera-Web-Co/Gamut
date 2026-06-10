import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";

const keys = {
  repos: ["repos"] as const,
  tags: ["tags"] as const,
  groups: ["groups"] as const,
};

export function useRepos() {
  return useQuery({ queryKey: keys.repos, queryFn: ipc.listRepos });
}

export function useTags() {
  return useQuery({ queryKey: keys.tags, queryFn: ipc.listTags });
}

export function useGroups() {
  return useQuery({ queryKey: keys.groups, queryFn: ipc.listGroups });
}

/** Invalidate everything the sidebar tree depends on. */
function useInvalidateTree() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: keys.repos });
    qc.invalidateQueries({ queryKey: keys.tags });
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

export function useCreateTag() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: ({ name, color }: { name: string; color: string }) =>
      ipc.createTag(name, color),
    onSuccess: invalidate,
  });
}

export function useDeleteTag() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (id: number) => ipc.deleteTag(id),
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

export function useSetRepoTags() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: ({ repoId, tagIds }: { repoId: number; tagIds: number[] }) =>
      ipc.setRepoTags(repoId, tagIds),
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
