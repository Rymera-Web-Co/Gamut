import { Channel, invoke } from "@tauri-apps/api/core";
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
  /** The repo's directory no longer exists on disk (deleted/moved away). */
  missing: boolean;
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
  has_uncommitted_changes: boolean;
}

/** A local branch whose upstream tracking ref is gone (merged & deleted on remote). */
export interface StaleBranch {
  name: string;
  upstream: string | null;
  last_commit_sha: string | null;
  last_commit_subject: string | null;
  last_commit_time: number | null;
}

export interface DeleteResult {
  name: string;
  deleted: boolean;
  error: string | null;
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
  /** When set, the group is bound to this folder and auto-synced. Immutable. */
  folder_path: string | null;
  /** UTC SQLite timestamp of the last folder scan, or null if never scanned. */
  last_scan_at: string | null;
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

export interface DirEntry {
  name: string;
  kind: "dir" | "file";
  is_symlink: boolean;
  is_ignored: boolean;
}

export interface FileContent {
  text: string | null;
  is_binary: boolean;
  too_large: boolean;
  encoding_error: boolean;
}

export interface BlameHunk {
  start_line: number;
  line_count: number;
  sha: string;
  short_sha: string;
  author: string;
  timestamp: number;
}

/** The working tree split into staged (HEAD → index) and unstaged (index → wd). */
export interface WorktreeStatus {
  staged: FileChange[];
  unstaged: FileChange[];
}

export interface StashEntry {
  index: number;
  message: string;
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
  /** Logins with a pending review request — matches "needs review from". */
  requested_reviewers: string[];
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
  review_id?: number | null;
  comments: ThreadComment[];
}

/** A non-comment event in a PR's timeline (commit, review request, label, …). */
export interface TimelineEvent {
  kind:
    | "committed"
    | "ready_for_review"
    | "convert_to_draft"
    | "review_requested"
    | "labeled"
    | "assigned"
    | "renamed"
    | "cross_referenced"
    | "closed"
    | "reopened"
    | "merged"
    | "head_ref_force_pushed"
    | "head_ref_deleted";
  created_at: string;
  actor?: string | null;
  actor_avatar?: string | null;
  // committed / merged
  sha?: string | null;
  short_sha?: string | null;
  message?: string | null;
  // review_requested / assigned — the reviewer/assignee login
  subject?: string | null;
  // labeled
  label?: string | null;
  label_color?: string | null;
  // renamed
  rename_from?: string | null;
  rename_to?: string | null;
  // cross_referenced
  ref_number?: number | null;
  ref_title?: string | null;
  ref_url?: string | null;
  ref_is_pull?: boolean | null;
  // true for additions (labeled/assigned/review_requested), false for removals
  added?: boolean | null;
}

export type MergeMethod = "merge" | "squash" | "rebase";

export interface Reviewer {
  login: string;
  avatar?: string | null;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | PENDING | DISMISSED
  re_requested: boolean;
}
export interface Person {
  login: string;
  avatar?: string | null;
}
export interface PrLabel {
  name: string;
  color: string;
}
export interface LinkedIssue {
  number: number;
  title: string;
  url: string;
  state: string;
}
export interface PrDetails {
  reviewers: Reviewer[];
  assignees: Person[];
  labels: PrLabel[];
  milestone?: string | null;
  linked_issues: LinkedIssue[];
}

export interface SyncStatus {
  upstream: string | null;
  ahead: number;
  behind: number;
}

/** Repo-wide find & replace query. `includes`/`excludes` are gitignore-style
 * globs (e.g. `src/**`, `*.rs`); empty `includes` means "everything". */
export interface SearchQuery {
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  includes: string[];
  excludes: string[];
  includeIgnored: boolean;
}

/** A match's span within a line preview, as UTF-16 offsets (slice the JS
 * string directly). */
export interface MatchRange {
  start: number;
  end: number;
}

export interface LineHit {
  line: number;
  preview: string;
  matches: MatchRange[];
  previewTruncated: boolean;
}

export interface FileHits {
  path: string;
  hits: LineHit[];
  matchCount: number;
  /** More matches in this file than were returned. */
  truncated: boolean;
}

export interface SearchResults {
  files: FileHits[];
  totalMatches: number;
  filesWithMatches: number;
  /** A global cap was hit; results are partial. */
  truncated: boolean;
}

/** Which lines of one file to replace (post opt-out). */
export interface ReplaceTarget {
  path: string;
  lines: number[];
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface ReplaceResult {
  filesChanged: number;
  replacements: number;
  skipped: SkippedFile[];
}

export const ipc = {
  ping: (name?: string) => invoke<string>("ping", { name }),
  dbHealth: () => invoke<DbHealth>("db_health"),

  // settings (generic key/value, `pref.`-namespaced user preferences)
  getSettings: () => invoke<Record<string, string>>("get_settings"),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),
  deleteSetting: (key: string) => invoke<void>("delete_setting", { key }),
  resetSettings: () => invoke<void>("reset_settings"),

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
  listStaleBranches: (repoId: number) =>
    invoke<StaleBranch[]>("list_stale_branches", { repoId }),
  deleteBranches: (repoId: number, names: string[]) =>
    invoke<DeleteResult[]>("delete_branches", { repoId, names }),

  // sync (network ops via git CLI)
  gitSyncStatus: (repoId: number) =>
    invoke<SyncStatus>("git_sync_status", { repoId }),
  gitFetch: (repoId: number) => invoke<string>("git_fetch", { repoId }),
  gitPull: (repoId: number) => invoke<string>("git_pull", { repoId }),
  gitPush: (repoId: number) => invoke<string>("git_push", { repoId }),
  gitCheckoutPr: (repoId: number, number: number, headRef: string) =>
    invoke<string>("git_checkout_pr", { repoId, number, headRef }),

  // working tree (staging / commit / stash)
  worktreeStatus: (repoId: number) =>
    invoke<WorktreeStatus>("git_worktree_status", { repoId }),
  worktreeFileDiff: (
    repoId: number,
    path: string,
    staged: boolean,
    oldPath?: string,
  ) =>
    invoke<FileDiff>("worktree_file_diff", { repoId, path, staged, oldPath }),
  gitStage: (repoId: number, paths: string[]) =>
    invoke<void>("git_stage", { repoId, paths }),
  gitUnstage: (repoId: number, paths: string[]) =>
    invoke<void>("git_unstage", { repoId, paths }),
  gitDiscard: (repoId: number, paths: string[]) =>
    invoke<void>("git_discard", { repoId, paths }),
  gitCommit: (repoId: number, message: string) =>
    invoke<string>("git_commit", { repoId, message }),
  gitStashList: (repoId: number) =>
    invoke<StashEntry[]>("git_stash_list", { repoId }),
  gitStashPush: (repoId: number, message: string | null, includeUntracked: boolean) =>
    invoke<string>("git_stash_push", { repoId, message, includeUntracked }),
  gitStashPop: (repoId: number, index: number) =>
    invoke<string>("git_stash_pop", { repoId, index }),
  gitStashApply: (repoId: number, index: number) =>
    invoke<string>("git_stash_apply", { repoId, index }),
  gitStashDrop: (repoId: number, index: number) =>
    invoke<string>("git_stash_drop", { repoId, index }),

  // tags
  listTags: () => invoke<Tag[]>("list_tags"),
  createTag: (name: string, color: string) =>
    invoke<Tag>("create_tag", { name, color }),
  deleteTag: (id: number) => invoke<void>("delete_tag", { id }),
  setRepoTags: (repoId: number, tagIds: number[]) =>
    invoke<void>("set_repo_tags", { repoId, tagIds }),

  // groups
  listGroups: () => invoke<Group[]>("list_groups"),
  createGroup: (
    name: string,
    icon: string | null,
    parentId: number | null = null,
    folderPath: string | null = null,
  ) => invoke<Group>("create_group", { name, parentId, icon, folderPath }),
  updateGroup: (id: number, name: string | null, icon: string | null) =>
    invoke<void>("update_group", { id, name, icon }),
  /** Scan a folder-bound group's folder now; returns the count of new repos. */
  syncGroupFolder: (groupId: number) =>
    invoke<number>("sync_group_folder", { groupId }),
  /** Bind a currently-unbound group to a folder (first bind; immutable after). */
  bindGroupFolder: (id: number, folderPath: string) =>
    invoke<void>("bind_group_folder", { id, folderPath }),
  /** Detach a group from its bound folder (keeps existing members). */
  unbindGroupFolder: (id: number) =>
    invoke<void>("unbind_group_folder", { id }),
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

  // working-tree files (browse / edit)
  listDir: (repoId: number, relPath: string) =>
    invoke<DirEntry[]>("list_dir", { repoId, relPath }),
  readFile: (repoId: number, relPath: string) =>
    invoke<FileContent>("read_file", { repoId, relPath }),
  writeFile: (repoId: number, relPath: string, contents: string) =>
    invoke<void>("write_file", { repoId, relPath, contents }),
  /** Create an empty file; rejects if the path already exists. */
  createFile: (repoId: number, relPath: string) =>
    invoke<void>("create_file", { repoId, relPath }),
  /** Create a directory; rejects if the path already exists. */
  createDir: (repoId: number, relPath: string) =>
    invoke<void>("create_dir", { repoId, relPath }),
  /** Delete a file or directory (directories are removed recursively). */
  deletePath: (repoId: number, relPath: string) =>
    invoke<void>("delete_path", { repoId, relPath }),
  /** Resolve a repo-relative tree path to its absolute filesystem path. */
  resolvePath: (repoId: number, relPath: string) =>
    invoke<string>("resolve_path", { repoId, relPath }),
  revealInFileManager: (repoId: number, relPath?: string | null) =>
    invoke<void>("reveal_in_file_manager", { repoId, relPath: relPath ?? null }),

  // repo-wide find & replace (per-file find is Monaco's native widget)
  searchRepo: (repoId: number, query: SearchQuery) =>
    invoke<SearchResults>("search_repo", { repoId, query }),
  replaceInFiles: (
    repoId: number,
    query: SearchQuery,
    replacement: string,
    targets: ReplaceTarget[],
  ) =>
    invoke<ReplaceResult>("replace_in_files", {
      repoId,
      query,
      replacement,
      targets,
    }),

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
  /** Fetch a GitHub-hosted attachment image as a `data:` URL (issue #36). */
  githubFetchImage: (url: string) =>
    invoke<string>("github_fetch_image", { url }),
  githubPrThread: (repoId: number, number: number) =>
    invoke<PrThread>("github_pr_thread", { repoId, number }),
  githubPrTimeline: (repoId: number, number: number) =>
    invoke<TimelineEvent[]>("github_pr_timeline", { repoId, number }),
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
  githubMergePr: (repoId: number, number: number, method: MergeMethod) =>
    invoke<void>("github_merge_pr", { repoId, number, method }),
  githubPrDetails: (repoId: number, number: number) =>
    invoke<PrDetails>("github_pr_details", { repoId, number }),

  // integrated terminal (PTY sessions keyed by an opaque scope id)
  /**
   * Spawn (or reuse) a shell for `sessionId` rooted at `cwd`, streaming its raw
   * output bytes to `onOutput`. Idempotent on the backend, so calling twice for
   * the same id is safe.
   */
  terminalSpawn: (
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
    onOutput: (bytes: Uint8Array) => void,
  ) => {
    const channel = new Channel<number[]>();
    channel.onmessage = (msg) => onOutput(new Uint8Array(msg));
    return invoke<void>("terminal_spawn", {
      sessionId,
      cwd,
      cols,
      rows,
      onOutput: channel,
    });
  },
  terminalWrite: (sessionId: string, data: Uint8Array) =>
    invoke<void>("terminal_write", { sessionId, data: Array.from(data) }),
  terminalResize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { sessionId, cols, rows }),
  terminalKill: (sessionId: string) =>
    invoke<void>("terminal_kill", { sessionId }),
  /** Read a custom notification sound file's raw bytes by path (#28). The
   * backend rejects non-audio extensions, so this isn't a general file read. */
  readAudioFile: (path: string) => invoke<ArrayBuffer>("read_audio_file", { path }),
};

/** Open the native folder picker. Returns the chosen absolute path, or null. */
export async function pickDirectory(title?: string): Promise<string | null> {
  const result = await openDialog({ directory: true, multiple: false, title });
  return typeof result === "string" ? result : null;
}

/** Audio file extensions a custom notification sound may use. */
export const AUDIO_EXTENSIONS = ["wav", "mp3", "ogg", "m4a", "aac", "flac"];

/** Open the native file picker filtered to audio files. Returns a path or null. */
export async function pickAudioFile(title?: string): Promise<string | null> {
  const result = await openDialog({
    directory: false,
    multiple: false,
    title: title ?? "Choose a notification sound",
    filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
  });
  return typeof result === "string" ? result : null;
}
