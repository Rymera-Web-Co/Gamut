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

export interface BranchInfo {
  name: string;
  is_head: boolean;
  is_remote: boolean;
}

export interface RepoStatus {
  id: number;
  branch: string | null;
  ahead: number;
  behind: number;
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
  icon: string | null;
  is_default: boolean;
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

export type ReviewSource = "working" | "branch";

export interface ReviewDiff {
  base_label: string;
  head_label: string;
  files: FileChange[];
}

export interface AuthStatus {
  logged_in: boolean;
  login: string | null;
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string | null;
  interval: number;
  expires_in: number;
}

export interface PrSummary {
  number: number;
  title: string;
  author: string;
  state: string;
  draft: boolean;
  base_ref: string;
  head_ref: string;
  head_sha: string;
  url: string;
  updated_at: string;
  author_avatar?: string | null;
}

/** An inline review comment anchored to a line (or range) of the diff. */
export interface DraftComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  body: string;
}

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface PrComment {
  id: number;
  author: string;
  body: string;
  created_at: string;
  kind: "comment" | "review" | "review_comment";
  state: string | null;
  author_avatar?: string | null;
  // Set for inline review comments ("review_comment").
  path?: string | null;
  line?: number | null;
  diff_hunk?: string | null;
  html_url?: string | null;
}

/** Where an editable body lives within a PR. */
export type BodyTarget = "pr" | "comment" | "review" | "review_comment";

export interface PrThread {
  title: string;
  author: string;
  state: string;
  body: string;
  created_at: string;
  author_avatar?: string | null;
  comments: PrComment[];
}

/** A single comment inside an inline review thread. */
export interface ThreadComment {
  id: number | null;
  author: string;
  author_avatar?: string | null;
  body: string;
  created_at: string;
  url?: string | null;
}

/** A grouped inline review-comment thread (root comment + replies). */
export interface ReviewThread {
  id: string; // GraphQL node id (for resolve/unresolve)
  is_resolved: boolean;
  is_outdated: boolean;
  path?: string | null;
  line?: number | null;
  diff_hunk?: string | null;
  comments: ThreadComment[];
}

export interface SyncStatus {
  upstream: string | null;
  ahead: number;
  behind: number;
}

export const ipc = {
  ping: (name?: string) => invoke<string>("ping", { name }),
  dbHealth: () => invoke<DbHealth>("db_health"),

  // repos
  listRepos: () => invoke<Repo[]>("list_repos"),
  repoStatuses: () => invoke<RepoStatus[]>("repo_statuses"),
  registerRepo: (path: string) => invoke<Repo>("register_repo", { path }),
  removeRepo: (id: number) => invoke<void>("remove_repo", { id }),
  touchRepo: (id: number) => invoke<void>("touch_repo", { id }),
  reorderRepos: (repoIds: number[]) =>
    invoke<void>("reorder_repos", { repoIds }),
  discoverRepos: (root: string, maxDepth?: number) =>
    invoke<DiscoveredRepo[]>("discover_repos", { root, maxDepth }),
  listBranches: (repoId: number) =>
    invoke<BranchInfo[]>("list_branches", { repoId }),
  listGitTags: (repoId: number) =>
    invoke<string[]>("list_git_tags", { repoId }),
  checkoutBranch: (repoId: number, name: string) =>
    invoke<void>("checkout_branch", { repoId, name }),

  // sync (network ops via git CLI)
  gitSyncStatus: (repoId: number) =>
    invoke<SyncStatus>("git_sync_status", { repoId }),
  gitFetch: (repoId: number) => invoke<string>("git_fetch", { repoId }),
  gitPull: (repoId: number) => invoke<string>("git_pull", { repoId }),
  gitPush: (repoId: number) => invoke<string>("git_push", { repoId }),
  gitCheckoutPr: (repoId: number, number: number, headRef: string) =>
    invoke<string>("git_checkout_pr", { repoId, number, headRef }),

  // tags
  listTags: () => invoke<Tag[]>("list_tags"),
  createTag: (name: string, color: string) =>
    invoke<Tag>("create_tag", { name, color }),
  deleteTag: (id: number) => invoke<void>("delete_tag", { id }),
  setRepoTags: (repoId: number, tagIds: number[]) =>
    invoke<void>("set_repo_tags", { repoId, tagIds }),

  // groups
  listGroups: () => invoke<Group[]>("list_groups"),
  createGroup: (name: string, icon: string | null, parentId: number | null = null) =>
    invoke<Group>("create_group", { name, parentId, icon }),
  updateGroup: (id: number, name: string | null, icon: string | null) =>
    invoke<void>("update_group", { id, name, icon }),
  reorderGroups: (groupIds: number[]) =>
    invoke<void>("reorder_groups", { groupIds }),
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

  // local review
  reviewFiles: (repoId: number, source: ReviewSource, base?: string) =>
    invoke<ReviewDiff>("review_files", { repoId, source, base }),
  reviewFileDiff: (
    repoId: number,
    source: ReviewSource,
    path: string,
    base?: string,
    oldPath?: string,
  ) =>
    invoke<FileDiff>("review_file_diff", {
      repoId,
      source,
      path,
      base,
      oldPath,
    }),

  // github
  githubSetToken: (token: string) =>
    invoke<AuthStatus>("github_set_token", { token }),
  githubAuthStatus: () => invoke<AuthStatus>("github_auth_status"),
  githubLogout: () => invoke<void>("github_logout"),
  githubOauthAvailable: () => invoke<boolean>("github_oauth_available"),
  githubDeviceStart: () => invoke<DeviceCode>("github_device_start"),
  githubDevicePoll: (deviceCode: string, interval: number, expiresIn: number) =>
    invoke<AuthStatus>("github_device_poll", {
      deviceCode,
      interval,
      expiresIn,
    }),
  githubListPrs: (repoId: number) =>
    invoke<PrSummary[]>("github_list_prs", { repoId }),
  githubPrDiff: (repoId: number, number: number) =>
    invoke<string>("github_pr_diff", { repoId, number }),
  githubPrThread: (repoId: number, number: number) =>
    invoke<PrThread>("github_pr_thread", { repoId, number }),
  githubSubmitReview: (
    repoId: number,
    number: number,
    event: ReviewEvent,
    body: string,
    commitId?: string | null,
    comments?: DraftComment[],
  ) =>
    invoke<void>("github_submit_review", {
      repoId,
      number,
      event,
      body,
      commitId: commitId ?? null,
      comments: comments ?? null,
    }),
  githubPrComment: (
    repoId: number,
    number: number,
    commitId: string,
    comment: DraftComment,
  ) =>
    invoke<void>("github_pr_comment", { repoId, number, commitId, comment }),
  githubUpdateBody: (
    repoId: number,
    number: number,
    target: BodyTarget,
    id: number | null,
    body: string,
  ) =>
    invoke<void>("github_update_body", { repoId, number, target, id, body }),
  githubMentionables: (repoId: number) =>
    invoke<string[]>("github_mentionables", { repoId }),
  githubReviewThreads: (repoId: number, number: number) =>
    invoke<ReviewThread[]>("github_review_threads", { repoId, number }),
  githubReplyReviewComment: (
    repoId: number,
    number: number,
    commentId: number,
    body: string,
  ) =>
    invoke<void>("github_reply_review_comment", {
      repoId,
      number,
      commentId,
      body,
    }),
  githubResolveThread: (threadId: string, resolved: boolean) =>
    invoke<void>("github_resolve_thread", { threadId, resolved }),
};

/** Open the native folder picker. Returns the chosen absolute path, or null. */
export async function pickDirectory(title?: string): Promise<string | null> {
  const result = await openDialog({ directory: true, multiple: false, title });
  return typeof result === "string" ? result : null;
}
