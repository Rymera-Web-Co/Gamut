import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

/**
 * Typed wrappers over Tauri's `invoke`. Every backend command should be
 * exposed here so the rest of the app calls strongly-typed functions instead
 * of stringly-typed `invoke("...")`.
 */

export interface DbHealth {
  ok: boolean;
  migrations: string[];
  repo_count: number;
}

export interface Repo {
  id: number;
  path: string;
  name: string;
  default_branch: string | null;
  last_opened: string | null;
  created_at: string;
  tag_ids: number[];
  group_ids: number[];
}

export interface DiscoveredRepo {
  path: string;
  name: string;
  default_branch: string | null;
  already_registered: boolean;
}

export interface Tag {
  id: number;
  name: string;
  color: string;
}

export interface Group {
  id: number;
  name: string;
  parent_id: number | null;
  sort: number;
}

export interface RefLabel {
  name: string;
  kind: "head" | "branch" | "remote" | "tag";
}

export interface GraphPath {
  from_col: number;
  from_y: number;
  to_col: number;
  to_y: number;
  color: number;
}

export interface CommitRow {
  sha: string;
  short_sha: string;
  parents: string[];
  author_name: string;
  author_email: string;
  timestamp: number;
  subject: string;
  refs: RefLabel[];
  node_col: number;
  color: number;
  paths: GraphPath[];
}

export interface LogPage {
  commits: CommitRow[];
  width: number;
  has_more: boolean;
}

export interface FileChange {
  path: string;
  old_path: string | null;
  status: string;
  additions: number;
  deletions: number;
}

export interface CommitDetail {
  sha: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  message: string;
  files: FileChange[];
}

export interface FileDiff {
  path: string;
  old_text: string | null;
  new_text: string | null;
  is_binary: boolean;
}

export interface BlameHunk {
  start_line: number;
  line_count: number;
  sha: string;
  short_sha: string;
  author: string;
  timestamp: number;
}

export const ipc = {
  ping: (name?: string) => invoke<string>("ping", { name }),
  dbHealth: () => invoke<DbHealth>("db_health"),

  // repos
  listRepos: () => invoke<Repo[]>("list_repos"),
  registerRepo: (path: string) => invoke<Repo>("register_repo", { path }),
  removeRepo: (id: number) => invoke<void>("remove_repo", { id }),
  touchRepo: (id: number) => invoke<void>("touch_repo", { id }),
  discoverRepos: (root: string, maxDepth?: number) =>
    invoke<DiscoveredRepo[]>("discover_repos", { root, maxDepth }),

  // tags
  listTags: () => invoke<Tag[]>("list_tags"),
  createTag: (name: string, color: string) =>
    invoke<Tag>("create_tag", { name, color }),
  deleteTag: (id: number) => invoke<void>("delete_tag", { id }),
  setRepoTags: (repoId: number, tagIds: number[]) =>
    invoke<void>("set_repo_tags", { repoId, tagIds }),

  // groups
  listGroups: () => invoke<Group[]>("list_groups"),
  createGroup: (name: string, parentId: number | null) =>
    invoke<Group>("create_group", { name, parentId }),
  deleteGroup: (id: number) => invoke<void>("delete_group", { id }),
  setRepoGroups: (repoId: number, groupIds: number[]) =>
    invoke<void>("set_repo_groups", { repoId, groupIds }),

  // history
  log: (repoId: number, offset: number, limit: number) =>
    invoke<LogPage>("log", { repoId, offset, limit }),
  commitDetail: (repoId: number, sha: string) =>
    invoke<CommitDetail>("commit_detail", { repoId, sha }),
  fileDiff: (repoId: number, sha: string, path: string, oldPath?: string) =>
    invoke<FileDiff>("file_diff", { repoId, sha, path, oldPath }),
  fileHistory: (repoId: number, path: string, limit: number) =>
    invoke<CommitRow[]>("file_history", { repoId, path, limit }),
  blame: (repoId: number, sha: string, path: string) =>
    invoke<BlameHunk[]>("blame", { repoId, sha, path }),
};

/** Open the native folder picker. Returns the chosen absolute path, or null. */
export async function pickDirectory(title?: string): Promise<string | null> {
  const result = await openDialog({ directory: true, multiple: false, title });
  return typeof result === "string" ? result : null;
}
