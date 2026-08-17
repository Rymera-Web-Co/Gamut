import { Channel, invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

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

/** One open terminal tab, mirrored to the backend for the `term-list` control
 * query. Field names are snake_case to match the Rust `TerminalInfo` struct. */
export interface TerminalInfo {
  group_id: number;
  tab_id: string;
  name: string;
  panes: number;
  cwd?: string;
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
  /**
   * Whether the entry is an actual git repository. Plain (non-git) folders can
   * be added too; for those only the Files tab is shown and all git operations
   * (status, branch, sync) are skipped.
   */
  is_git_repo: boolean;
  /**
   * Cached "has any linked worktree" flag, maintained by the status scan. The
   * sidebar uses it to decide whether to run `git worktree list` at all — repos
   * with none skip that subprocess. May lag until the next scan; the live value
   * is on `RepoStatus.has_worktrees`.
   */
  has_worktrees: boolean;
  /**
   * Opted into background auto-pull (#299): when the app notices this repo is
   * behind its upstream it fast-forwards the branch for you. Off by default, and
   * only ever a clean fast-forward — see `lib/autoPull.ts`.
   */
  auto_pull: boolean;
}

/**
 * One entry of `git worktree list` — the repo's main working tree or a linked
 * worktree created with `git worktree add`. Discovered from git itself, so
 * worktrees created by any external tool show up too.
 */
export interface LinkedWorktree {
  repo_id: number;
  /** Absolute path of the working tree checkout. */
  path: string;
  /** Checked-out branch (no `refs/heads/` prefix); null when detached or bare. */
  branch: string | null;
  head: string | null;
  /** Whether this is the repo's main working tree. */
  is_main: boolean;
  /** The checkout directory no longer exists on disk (prunable). */
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

/**
 * One occurrence of a config key (#306) — `Config::entries` returns one row per
 * layer/multivar value, not just the winner, so inherited values never look
 * local. `value` is `null` for a non-UTF-8 entry; `level` is one of the seven
 * git config levels (`system`, `global`, `global (xdg)`, `local`, `worktree`,
 * `app`); `effective` marks the occurrence git actually resolves to. A
 * multivar key (multiple values at one level, e.g. `remote.origin.fetch`) is
 * NOT ambiguous here either — git resolves it to the LAST value written, so
 * that occurrence is marked effective exactly like any other key.
 */
export interface ConfigEntry {
  name: string;
  value: string | null;
  level: string;
  effective: boolean;
}

/** One identity field (`user.name`/`user.email`): the effective value plus the
 * level it resolves from, and the raw local-scope value so the editor can tell
 * "inherited from global" apart from "set here". */
export interface IdentityValue {
  value: string | null;
  level: string | null;
  local_value: string | null;
}

export interface Identity {
  name: IdentityValue;
  email: IdentityValue;
}

/** A configured remote — name plus its **unredacted** URL (the editor
 * round-trips it; see `ConfigEntry` for the redacted table view). */
export interface RemoteRow {
  name: string;
  url: string;
  /** `remote.<name>.pushurl`, when set and distinct from `url`. Disclosure
   * only — never edited here, so retargeting `url` can't silently leave
   * pushes still going to a stale host. */
  push_url: string | null;
}

/** A local branch's current upstream wiring, read straight from
 * `branch.<name>.remote`/`.merge` rather than the resolved remote-tracking ref,
 * so a dangling upstream still shows what's configured. */
export interface BranchRow {
  name: string;
  remote: string | null;
  merge: string | null;
  is_head: boolean;
}

/** The effective git config for a repo (#306): every occurrence, source-
 * annotated, plus identity/remotes/branch-upstream wiring for the curated
 * editors and the remote-tracking branch names for the upstream picker. */
export interface ConfigOverview {
  entries: ConfigEntry[];
  identity: Identity;
  remotes: RemoteRow[];
  branches: BranchRow[];
  remote_branches: string[];
}

/** Which identity key a curated write targets — mirrors the Rust `IdentityField`. */
export type IdentityFieldName = "name" | "email";

export interface RepoStatus {
  id: number;
  branch: string | null;
  ahead: number;
  behind: number;
  has_uncommitted_changes: boolean;
  /** Live "has any linked worktree" flag; refreshes the persisted Repo flag. */
  has_worktrees: boolean;
}

/**
 * What auto-pull did to one repo (#299). Everything but `pulled` left the repo
 * untouched; the `skipped-*` values are the safety rules refusing to act, and are
 * what the non-blocking warnings are built from.
 */
export type AutoPullStatus =
  | "pulled"
  | "up-to-date"
  | "skipped-dirty"
  | "skipped-diverged"
  | "skipped-no-upstream"
  /** Folder gone, not a git repo, or not opted in — nothing to pull, nothing to say. */
  | "skipped-unavailable"
  | "failed";

/** Per-repo outcome of one `git_pull_ff_many` call. */
export interface AutoPullResult {
  repo_id: number;
  status: AutoPullStatus;
  /** Raw `git pull` stdout for a pulled repo, condensed by `summarizePull`. */
  output: string | null;
  /** git's stderr when `status` is `failed`. */
  error: string | null;
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
  /**
   * Repos-row id of the bound folder itself (the synced root), once a scan has
   * registered it. Null for manual groups or before the first scan. Used to tag
   * and optionally hide the root entry, apart from discovered subfolders.
   */
  root_repo_id: number | null;
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

/** A working-tree image loaded for inline preview (see `read_image_file`). */
export interface ImageContent {
  /** `data:<mime>;base64,<…>` — usable directly as an `<img>` src. */
  data_url: string;
  byte_len: number;
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

/** Result of a File Compare (#130): the two sides for the diff viewer. */
export interface CompareResult {
  /** `null` when that side is binary or unreadable. */
  left_text: string | null;
  right_text: string | null;
  left_label: string;
  right_label: string;
  is_binary: boolean;
  identical: boolean;
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

/** A PR web URL resolved to a tracked repo + number (terminal link handling). */
export interface PrRef {
  repo_id: number;
  number: number;
}

/**
 * A file path seen in terminal output, resolved to an absolute path and — when
 * it lives inside a tracked repo — that repo + its repo-relative path (#255).
 * `repo_id`/`rel_path` are null when the path is outside every tracked repo, so
 * the caller opens `abs_path` with the OS default app instead.
 */
export interface ResolvedTermPath {
  abs_path: string;
  is_dir: boolean;
  repo_id: number | null;
  rel_path: string | null;
}

/**
 * An editor selection pushed to connected `claude` clients via the Claude Code
 * IDE integration. Line/character are **zero-based** (the protocol's LSP-style
 * coordinates) — Monaco's 1-based line/column must be converted before sending.
 * Field names are snake_case to match the backend `Selection` struct.
 */
export interface IdeSelection {
  text: string;
  /** Absolute path of the file the selection is in. */
  file_path: string;
  start_line: number;
  start_char: number;
  end_line: number;
  end_char: number;
  is_empty: boolean;
}

/** Status of the Claude Code IDE WebSocket server. */
export interface IdeStatus {
  running: boolean;
  port: number | null;
  connected: number;
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
/** A single CI / status check on the PR's head commit. */
export interface StatusCheck {
  name: string;
  /** SUCCESS | FAILURE | PENDING | NEUTRAL | ERROR. */
  state: string;
  url?: string | null;
}

/** The PR's rolled-up merge requirements (review decision, mergeable state,
 * draft flag, and head-commit CI checks) — used to gate the merge button (#185). */
export interface MergeInfo {
  /** The PR's GraphQL node id, for the draft-state mutations (#288). Empty when
   * the PR node couldn't be resolved. */
  id: string;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null. */
  review_decision?: string | null;
  /** MERGEABLE | CONFLICTING | UNKNOWN (UNKNOWN while GitHub is still computing). */
  mergeable: string;
  /** CLEAN | UNSTABLE | BLOCKED | BEHIND | DIRTY | DRAFT | HAS_HOOKS | UNKNOWN. */
  merge_state_status: string;
  is_draft: boolean;
  /** SUCCESS | FAILURE | PENDING | ERROR | EXPECTED | null. */
  check_rollup?: string | null;
  checks: StatusCheck[];
}

export interface PrDetails {
  reviewers: Reviewer[];
  assignees: Person[];
  labels: PrLabel[];
  milestone?: string | null;
  linked_issues: LinkedIssue[];
  merge: MergeInfo;
}

export interface SyncStatus {
  upstream: string | null;
  ahead: number;
  behind: number;
  /**
   * The branch a push would **publish** — set only when HEAD is a branch with no
   * upstream, so pushing creates it on `origin` for the first time. `null` when
   * the branch already tracks, or HEAD is detached: both push plainly. This is
   * the exact value the push itself acts on, so the confirmation shown before a
   * first push (#300) can't disagree with what the push then does.
   */
  unpublished_branch: string | null;
}

/** Per-repo outcome of a batch fetch (`gitFetchMany`). */
export interface FetchResult {
  repo_id: number;
  ok: boolean;
  error: string | null;
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

/** One recorded git-operation timing in the diagnostics log (#90). */
export interface OpTiming {
  op: string;
  repo_id: number | null;
  duration_ms: number;
  ok: boolean;
  at_ms: number;
  detail: string | null;
}

/** Per-operation aggregate over the diagnostics log. */
export interface OpStat {
  op: string;
  count: number;
  fail_count: number;
  max_ms: number;
  avg_ms: number;
}

/** One captured error-toast message in the diagnostics log (#301). */
export interface ErrorEntry {
  at_ms: number;
  message: string;
}

/** A point-in-time diagnostics bundle (#90). */
export interface Diagnostics {
  app_version: string;
  os: string;
  arch: string;
  generated_at_ms: number;
  repo_count: number;
  group_count: number;
  watched_path_count: number;
  watch_failed_count: number;
  op_stats: OpStat[];
  recent_ops: OpTiming[];
  /** Optional defensively: read as `?? []` so a partial payload renders the
   * empty state instead of blanking the whole panel (#301). */
  recent_errors?: ErrorEntry[];
}

export const ipc = {
  ping: (name?: string) => invoke<string>("ping", { name }),
  dbHealth: () => invoke<DbHealth>("db_health"),

  // settings (generic key/value, `pref.`-namespaced user preferences)
  getSettings: () => invoke<Record<string, string>>("get_settings"),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  deleteSetting: (key: string) => invoke<void>("delete_setting", { key }),
  resetSettings: () => invoke<void>("reset_settings"),

  // repos
  listRepos: () => invoke<Repo[]>("list_repos"),
  repoStatuses: () => invoke<RepoStatus[]>("repo_statuses"),
  /** Statuses for just the given repos — the watcher's scoped refresh path. */
  repoStatusesFor: (repoIds: number[]) => invoke<RepoStatus[]>("repo_statuses_for", { repoIds }),
  repoStatus: (repoId: number) => invoke<RepoStatus>("repo_status", { repoId }),
  registerRepo: (path: string) => invoke<Repo>("register_repo", { path }),
  /** Remove one or more repos in a single round trip — DB-only, files on disk
   * are untouched. A single-repo removal passes a one-element array. */
  removeRepos: (ids: number[]) => invoke<void>("remove_repos", { ids }),
  touchRepo: (id: number) => invoke<void>("touch_repo", { id }),
  /** Turn this repo's background auto-pull opt-in on or off (#299). */
  setRepoAutoPull: (repoId: number, enabled: boolean) =>
    invoke<void>("set_repo_auto_pull", { repoId, enabled }),
  discoverRepos: (root: string, maxDepth?: number) =>
    invoke<DiscoveredRepo[]>("discover_repos", { root, maxDepth }),
  listBranches: (repoId: number) => invoke<BranchInfo[]>("list_branches", { repoId }),
  listGitTags: (repoId: number) => invoke<string[]>("list_git_tags", { repoId }),
  checkoutBranch: (repoId: number, name: string) =>
    invoke<void>("checkout_branch", { repoId, name }),
  /** Create a local branch (from `fromRef`, else HEAD) and check it out (#131). */
  createBranch: (repoId: number, name: string, fromRef?: string) =>
    invoke<void>("create_branch", { repoId, name, fromRef: fromRef ?? null }),
  listStaleBranches: (repoId: number) => invoke<StaleBranch[]>("list_stale_branches", { repoId }),
  deleteBranches: (repoId: number, names: string[]) =>
    invoke<DeleteResult[]>("delete_branches", { repoId, names }),

  // git config (#306) — read the effective config, edit a curated safe subset
  // at local scope only.
  gitConfigOverview: (repoId: number) => invoke<ConfigOverview>("git_config_overview", { repoId }),
  /** `value: null` (or blank) clears the local key so the inherited value applies. */
  gitConfigSetIdentity: (repoId: number, field: IdentityFieldName, value: string | null) =>
    invoke<void>("git_config_set_identity", { repoId, field, value }),
  gitConfigSetRemoteUrl: (repoId: number, remote: string, url: string) =>
    invoke<void>("git_config_set_remote_url", { repoId, remote, url }),
  /** `upstream: null` clears the branch's upstream. */
  gitConfigSetBranchUpstream: (repoId: number, branch: string, upstream: string | null) =>
    invoke<void>("git_config_set_branch_upstream", { repoId, branch, upstream }),

  // sync (network ops via git CLI)
  gitSyncStatus: (repoId: number) => invoke<SyncStatus>("git_sync_status", { repoId }),
  gitFetch: (repoId: number) => invoke<string>("git_fetch", { repoId }),
  gitFetchMany: (repoIds: number[]) => invoke<FetchResult[]>("git_fetch_many", { repoIds }),
  gitPull: (repoId: number) => invoke<string>("git_pull", { repoId }),
  /**
   * Fast-forward the auto-pull-enabled repos among `repoIds` (#299). The backend
   * owns the safety decision: an ineligible repo (dirty, diverged, no upstream)
   * comes back with a `skipped-*` status instead of being touched.
   */
  gitPullFfMany: (repoIds: number[]) => invoke<AutoPullResult[]>("git_pull_ff_many", { repoIds }),
  gitPush: (repoId: number) => invoke<string>("git_push", { repoId }),
  gitCheckoutPr: (repoId: number, number: number, headRef: string) =>
    invoke<string>("git_checkout_pr", { repoId, number, headRef }),

  // working tree (staging / commit / stash)
  worktreeStatus: (repoId: number) => invoke<WorktreeStatus>("git_worktree_status", { repoId }),
  gitWorktreeList: (repoId: number) => invoke<LinkedWorktree[]>("git_worktree_list", { repoId }),
  worktreeFileDiff: (repoId: number, path: string, staged: boolean, oldPath?: string) =>
    invoke<FileDiff>("worktree_file_diff", { repoId, path, staged, oldPath }),
  gitStage: (repoId: number, paths: string[]) => invoke<void>("git_stage", { repoId, paths }),
  gitUnstage: (repoId: number, paths: string[]) => invoke<void>("git_unstage", { repoId, paths }),
  gitDiscard: (repoId: number, paths: string[]) => invoke<void>("git_discard", { repoId, paths }),
  gitCommit: (repoId: number, message: string) => invoke<string>("git_commit", { repoId, message }),
  gitStashList: (repoId: number) => invoke<StashEntry[]>("git_stash_list", { repoId }),
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
  createTag: (name: string, color: string) => invoke<Tag>("create_tag", { name, color }),
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
  syncGroupFolder: (groupId: number) => invoke<number>("sync_group_folder", { groupId }),
  /** Bind a currently-unbound group to a folder (first bind; immutable after). */
  bindGroupFolder: (id: number, folderPath: string) =>
    invoke<void>("bind_group_folder", { id, folderPath }),
  /** Detach a group from its bound folder (keeps existing members). */
  unbindGroupFolder: (id: number) => invoke<void>("unbind_group_folder", { id }),
  deleteGroup: (id: number) => invoke<void>("delete_group", { id }),
  setRepoGroups: (repoId: number, groupIds: number[]) =>
    invoke<void>("set_repo_groups", { repoId, groupIds }),

  // history
  log: (repoId: number, offset: number, limit: number, revspec?: string | null) =>
    invoke<LogPage>("log", { repoId, offset, limit, revspec: revspec ?? null }),
  commitDetail: (repoId: number, sha: string) =>
    invoke<CommitDetail>("commit_detail", { repoId, sha }),
  fileDiff: (repoId: number, sha: string, path: string, oldPath?: string) =>
    invoke<FileDiff>("file_diff", { repoId, sha, path, oldPath }),
  fileHistory: (repoId: number, path: string, limit: number) =>
    invoke<CommitRow[]>("file_history", { repoId, path, limit }),
  blame: (repoId: number, sha: string, path: string) =>
    invoke<BlameHunk[]>("blame", { repoId, sha, path }),

  // working-tree files (browse / edit)
  listDir: (repoId: number, relPath: string) => invoke<DirEntry[]>("list_dir", { repoId, relPath }),
  readFile: (repoId: number, relPath: string) =>
    invoke<FileContent>("read_file", { repoId, relPath }),
  readImageFile: (repoId: number, relPath: string) =>
    invoke<ImageContent>("read_image_file", { repoId, relPath }),
  writeFile: (repoId: number, relPath: string, contents: string) =>
    invoke<void>("write_file", { repoId, relPath, contents }),
  /** Create an empty file; rejects if the path already exists. */
  createFile: (repoId: number, relPath: string) => invoke<void>("create_file", { repoId, relPath }),
  /** Create a directory; rejects if the path already exists. */
  createDir: (repoId: number, relPath: string) => invoke<void>("create_dir", { repoId, relPath }),
  /** Delete a file or directory (directories are removed recursively). */
  deletePath: (repoId: number, relPath: string) => invoke<void>("delete_path", { repoId, relPath }),
  /** Rename or move an entry; rejects if a different entry already exists there. */
  renamePath: (repoId: number, fromPath: string, toPath: string) =>
    invoke<void>("rename_path", { repoId, fromPath, toPath }),
  /** Resolve a repo-relative tree path to its absolute filesystem path. */
  resolvePath: (repoId: number, relPath: string) =>
    invoke<string>("resolve_path", { repoId, relPath }),
  /**
   * Resolve a file path seen in terminal output (absolute, `~`-relative, or
   * relative to `cwd`) to an absolute path plus the tracked repo containing it,
   * or `null` when the path doesn't exist on disk. Powers the terminal's
   * clickable file paths (#255).
   */
  resolveTerminalPath: (path: string, cwd: string) =>
    invoke<ResolvedTermPath | null>("resolve_terminal_path", { path, cwd }),
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

  // file compare (#130)
  /** Diff two arbitrary files anywhere on disk. */
  compareFiles: (leftPath: string, rightPath: string) =>
    invoke<CompareResult>("compare_files", { leftPath, rightPath }),
  /**
   * Diff one repo-relative file across refs / the working tree. A `null` ref
   * means the working tree; any string is a revparse target (branch/tag/sha).
   */
  compareRefs: (repoId: number, path: string, leftRef: string | null, rightRef: string | null) =>
    invoke<CompareResult>("compare_refs", { repoId, path, leftRef, rightRef }),
  /** Write edited content back to an absolute file path (editable compare, #130). */
  writeCompareFile: (path: string, content: string) =>
    invoke<void>("write_compare_file", { path, content }),

  // github
  githubSetToken: (token: string) => invoke<AuthStatus>("github_set_token", { token }),
  githubAuthStatus: () => invoke<AuthStatus>("github_auth_status"),
  githubLogout: () => invoke<void>("github_logout"),
  /** Verify the stored token against the configured API host (GHES) (issue #34). */
  githubCheck: () => invoke<AuthStatus>("github_check"),
  githubOauthAvailable: () => invoke<boolean>("github_oauth_available"),
  githubDeviceStart: () => invoke<DeviceCode>("github_device_start"),
  githubDevicePoll: (deviceCode: string, interval: number, expiresIn: number) =>
    invoke<AuthStatus>("github_device_poll", {
      deviceCode,
      interval,
      expiresIn,
    }),
  githubListPrs: (repoId: number) => invoke<PrSummary[]>("github_list_prs", { repoId }),
  /**
   * Resolve a GitHub PR web URL to a tracked repo + PR number, or `null` when the
   * URL isn't a PR or its repo isn't tracked. Used to open PR links from the
   * integrated terminal in-app rather than the browser (issue #51).
   */
  githubResolvePrUrl: (url: string) => invoke<PrRef | null>("github_resolve_pr_url", { url }),
  /** Browser-openable https URL of the repo's `origin` remote, or null if none. */
  repoRemoteUrl: (repoId: number) => invoke<string | null>("repo_remote_url", { repoId }),
  githubPrDiff: (repoId: number, number: number) =>
    invoke<string>("github_pr_diff", { repoId, number }),
  /**
   * The GitHub avatar URL for a commit's author, resolved from the repo's GitHub
   * remote and cached (by author email) so history browsing doesn't refetch the
   * same authors (issue #195). Null when the repo isn't on GitHub, we're
   * unauthenticated, or the email maps to no GitHub account.
   */
  githubCommitAvatar: (repoId: number, sha: string, email: string) =>
    invoke<string | null>("github_commit_avatar", { repoId, sha, email }),
  /** Fetch a GitHub-hosted attachment image as a `data:` URL (issue #36). */
  githubFetchImage: (url: string) => invoke<string>("github_fetch_image", { url }),
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
  /** Request (or re-request) reviews from one or more reviewers (#172). */
  githubRequestReview: (repoId: number, number: number, reviewers: string[]) =>
    invoke<void>("github_request_review", { repoId, number, reviewers }),
  githubPrComment: (repoId: number, number: number, commitId: string, comment: DraftComment) =>
    invoke<void>("github_pr_comment", { repoId, number, commitId, comment }),
  githubUpdateBody: (
    repoId: number,
    number: number,
    target: BodyTarget,
    id: number | null,
    body: string,
  ) => invoke<void>("github_update_body", { repoId, number, target, id, body }),
  githubMentionables: (repoId: number) => invoke<string[]>("github_mentionables", { repoId }),
  githubReviewThreads: (repoId: number, number: number) =>
    invoke<ReviewThread[]>("github_review_threads", { repoId, number }),
  githubReplyReviewComment: (repoId: number, number: number, commentId: number, body: string) =>
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
  /** Flip a draft PR to "ready for review" by its GraphQL node id (#288). */
  githubMarkPrReady: (pullRequestId: string) =>
    invoke<void>("github_mark_pr_ready", { pullRequestId }),
  /** Convert an open PR back to a draft by its GraphQL node id (#288). */
  githubConvertPrToDraft: (pullRequestId: string) =>
    invoke<void>("github_convert_pr_to_draft", { pullRequestId }),
  /** Whether a branch still exists on the repo's GitHub origin (#132). */
  githubRemoteBranchExists: (repoId: number, branch: string) =>
    invoke<boolean>("github_remote_branch_exists", { repoId, branch }),
  githubPrDetails: (repoId: number, number: number) =>
    invoke<PrDetails>("github_pr_details", { repoId, number }),

  // integrated terminal (PTY sessions keyed by an opaque scope id)
  /**
   * Spawn (or reuse) a shell for `sessionId` rooted at `cwd`, streaming its raw
   * output bytes to `onOutput`. Idempotent on the backend, so calling twice for
   * the same id is safe.
   *
   * Returns the spawn promise plus a `dispose` that detaches the output
   * `Channel` callback. Without it a respawn/restart leaks the original
   * callback, which keeps firing against a now-disposed consumer (#139); call
   * `dispose` whenever the consuming terminal is torn down.
   */
  terminalSpawn: (
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
    onOutput: (bytes: Uint8Array) => void,
  ): { ready: Promise<void>; dispose: () => void } => {
    // Backend sends raw bytes via `tauri::ipc::Response`, which arrive here as
    // an ArrayBuffer (ArrayBuffer over IPC, not a JSON `number[]` — avoids a
    // 3-4x size expansion and a JSON.parse pass for every chunk under heavy
    // output, see #203).
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (msg) => onOutput(new Uint8Array(msg));
    const ready = invoke<void>("terminal_spawn", {
      sessionId,
      cwd,
      cols,
      rows,
      onOutput: channel,
    });
    // Replace the handler with a no-op so late bytes from the backend are
    // dropped instead of reaching a stale consumer.
    const dispose = () => {
      channel.onmessage = () => {};
    };
    return { ready, dispose };
  },
  /**
   * Forward keystrokes to a session's shell. The bytes go over IPC as a raw
   * request body (not a JSON `number[]`), matching the ArrayBuffer output path
   * (#203): no 3-4x size expansion or per-keystroke `Array.from` + JSON parse,
   * which matters most when pasting. The session id travels in a header since
   * the body is the payload.
   */
  terminalWrite: (sessionId: string, data: Uint8Array) =>
    invoke<void>("terminal_write", data, { headers: { "session-id": sessionId } }),
  terminalResize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { sessionId, cols, rows }),
  terminalKill: (sessionId: string) => invoke<void>("terminal_kill", { sessionId }),
  /** Mirror the open terminal tabs to the backend so the local control channel's
   * `term-list` query can report active terminals. Fire-and-forget on layout change. */
  terminalRegistryReport: (terminals: TerminalInfo[]) =>
    invoke<void>("terminal_registry_report", { terminals }),
  /** Play a terminal notification cue natively in the host process (#28). `name`
   * is a built-in tone id or "custom" (which plays `customPath`). Playing in
   * Rust rather than the webview's Web Audio API keeps cues audible after the
   * machine's been idle, where WebKit would idle-suspend the AudioContext
   * (#119, #167). Rejects only a missing/invalid custom path; decode/playback
   * failures fall back to a built-in tone on the backend. */
  playSound: (name: string, customPath?: string) =>
    invoke<void>("play_notification_sound", { name, customPath }),

  // diagnostics (#90)
  diagnostics: () => invoke<Diagnostics>("diagnostics_snapshot"),
  diagnosticsWrite: (path: string) => invoke<void>("diagnostics_write", { path }),
  recordStall: (gapMs: number) => invoke<void>("diagnostics_record_stall", { gapMs }),
  // captured error log (#301)
  recordError: (message: string) => invoke<void>("errors_record", { message }),
  clearErrors: () => invoke<void>("errors_clear"),

  // Claude Code IDE integration: push the current editor selection to any
  // `claude` running in an integrated terminal, so it lands as ambient context.
  ideStatus: () => invoke<IdeStatus>("ide_status"),
  ideSelectionChanged: (selection: IdeSelection) =>
    invoke<void>("ide_selection_changed", { selection }),
};

/** Open the native save dialog. Returns the chosen path, or null if cancelled. */
export async function pickSavePath(defaultName: string): Promise<string | null> {
  const result = await saveDialog({ defaultPath: defaultName });
  return typeof result === "string" ? result : null;
}

/** Open the native folder picker. Returns the chosen absolute path, or null. */
export async function pickDirectory(title?: string): Promise<string | null> {
  const result = await openDialog({ directory: true, multiple: false, title });
  return typeof result === "string" ? result : null;
}

/** Open the native file picker. Returns the chosen absolute path, or null (#130). */
export async function pickFile(title?: string): Promise<string | null> {
  const result = await openDialog({ directory: false, multiple: false, title });
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
