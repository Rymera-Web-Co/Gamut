import { summarizePull } from "@/features/sync/summarizePull";
import { ipc, type AutoPullStatus, type Repo } from "@/lib/ipc";
import { toast } from "@/store/toast";

/**
 * Background auto-pull for opted-in repos (issue #299).
 *
 * The app already fetches every repo on an interval, so it knows the moment a
 * repo falls behind its upstream — but acting on that was still a manual,
 * one-repo-at-a-time click. A repo the user has opted in (`Repo.auto_pull`, set
 * from the sidebar's context menu) gets fast-forwarded instead.
 *
 * This module is the engine, deliberately trigger-agnostic: `useAutoPull` drives
 * it on launch and window-focus regain, and `useAutoFetch` drives it right after
 * each background fetch cycle. It performs **no query invalidation of its own** —
 * it returns the ids that actually pulled, and the caller folds them into the
 * refresh round it was already doing. That is what keeps a pull from kicking off
 * a second status-scan stampede on top of the post-fetch one (#206/#275).
 *
 * Safety lives in the backend (`sync::git_pull_ff_many`): it re-checks the opt-in
 * itself, only a clean fast-forward is ever performed, and the pull runs
 * `--ff-only` with autostash disabled. Everything else comes back as a `skipped-*`
 * status, which this module turns into a non-blocking warning rather than a silent
 * no-op.
 */

/**
 * User-facing reason a repo was left alone, keyed by backend status. Statuses
 * absent here are never announced: `pulled` and `up-to-date` are not warnings
 * (in particular a repo that is dirty but *not behind* reports `up-to-date`, so
 * working in a repo never warns every cycle), and `skipped-unavailable` means the
 * folder is gone or the repo isn't opted in — not something to nag about.
 */
const SKIP_REASONS: Partial<Record<AutoPullStatus, string>> = {
  "skipped-dirty": "you have uncommitted changes",
  "skipped-diverged": "the branch has diverged from its upstream",
  "skipped-no-upstream": "the branch has no upstream to pull from",
};

/**
 * Outcomes that need no word to the user: a successful or unnecessary pull, and a
 * repo that simply wasn't available to pull.
 */
const SILENT_STATUSES: ReadonlySet<AutoPullStatus> = new Set<AutoPullStatus>([
  "pulled",
  "up-to-date",
  "skipped-unavailable",
]);

/** Longest git error text a toast will carry; see {@link warnOnce}. */
const MAX_ERROR_CHARS = 120;

/**
 * The last warning shown per repo, so a repo that stays dirty doesn't warn on
 * every single cycle. Cleared for a repo as soon as it has a non-warning outcome,
 * so the *next* time it genuinely gets skipped the user hears about it again — a
 * permanent mute would hide a repo that silently stopped keeping up. Module-level,
 * because the triggers are separate hooks that must share one memory.
 */
const lastWarned = new Map<number, string>();

/**
 * The round currently in flight, with the scope it covers (`null` = every
 * opted-in repo). Two concurrent `--ff-only` runs on the same repo would
 * duplicate both the work and the toast, so a new request either **joins** this
 * round (when this round already covers it) or **queues behind** it (when the new
 * request is wider — e.g. a focus regain wanting every repo arrives while a
 * fetch-cycle round for one repo is still running). Joining a narrower round
 * would silently drop the wider request's repos.
 */
let inFlight: { scope: ReadonlySet<number> | null; promise: Promise<number[]> } | null = null;

/**
 * Whether a repo *could* be auto-pulled at all — it needs a real git checkout to
 * fast-forward, so plain (non-git) folders and repos whose folder has gone are
 * out regardless of the flag. Shared with the sidebar, which uses it to decide
 * whether to even offer the opt-in: the menu shows the toggle for exactly the
 * repos this engine would act on.
 */
export function canAutoPull(repo: Repo): boolean {
  return repo.is_git_repo && !repo.missing;
}

/** Repos eligible to even be asked about: opted in, present on disk, and git. */
function candidates(repos: Repo[], scope: ReadonlySet<number> | null): number[] {
  return repos
    .filter((r) => r.auto_pull && canAutoPull(r))
    .filter((r) => scope === null || scope.has(r.id))
    .map((r) => r.id);
}

/** Whether a round scoped to `covering` also covers a request for `wanted`. */
function covers(covering: ReadonlySet<number> | null, wanted: ReadonlySet<number> | null): boolean {
  if (covering === null) return true; // an all-repos round covers everything
  if (wanted === null) return false; // …but a scoped round can't cover all-repos
  for (const id of wanted) if (!covering.has(id)) return false;
  return true;
}

/**
 * Warn once per repo per distinct reason; see {@link lastWarned}. `detail` (git's
 * own error text, for a failed pull) is part of the de-duplication key so a
 * *different* second error still gets through, and is trimmed to one line so a
 * multi-line git error can't blow up the toast — the same restraint
 * `summarizePull` applies to the success path.
 */
function warnOnce(repoId: number, name: string, status: AutoPullStatus, detail?: string) {
  const trimmed = detail?.split("\n")[0]?.trim().slice(0, MAX_ERROR_CHARS);
  const reason = SKIP_REASONS[status] ?? trimmed ?? "the pull could not be completed";
  const key = `${status}:${reason}`;
  if (lastWarned.get(repoId) === key) return;
  lastWarned.set(repoId, key);
  toast.info(`${name}: auto-pull skipped — ${reason}`);
}

/**
 * Fast-forward every opted-in repo that has fallen behind, and report what
 * happened.
 *
 * @param only Restricts the round to these repo ids — the fetch cycle passes the
 *   repos whose fetch actually succeeded. Omit for every opted-in repo.
 * @param repos An already-loaded repo list, so a caller that just fetched one
 *   (the auto-fetch tick) doesn't pay for a second `list_repos` — which stats
 *   every repo path — on every cycle.
 * @returns the ids that were fast-forwarded; the caller refreshes those. Resolves
 *   to `[]` when there is nothing to do, and never throws: a background sync must
 *   not surface an unhandled rejection.
 */
export function runAutoPull(only?: number[], repos?: Repo[]): Promise<number[]> {
  const scope = only ? new Set(only) : null;

  if (inFlight) {
    // Already covered by the running round — join it rather than duplicating it.
    if (covers(inFlight.scope, scope)) return inFlight.promise;
    // Wider than the running round: run *after* it, never alongside it, so the
    // extra repos still get their turn without two pulls racing on one repo.
    const previous = inFlight.promise;
    const chained = previous.catch(() => []).then(() => pullRound(scope, repos));
    track(scope, chained);
    return chained;
  }

  const round = pullRound(scope, repos);
  track(scope, round);
  return round;
}

/**
 * Record `promise` as the in-flight round and release the slot when it settles —
 * but only if it is still the current round, so a late settle can never clear a
 * newer round's guard.
 */
function track(scope: ReadonlySet<number> | null, promise: Promise<number[]>) {
  const entry = { scope, promise };
  inFlight = entry;
  const release = () => {
    if (inFlight === entry) inFlight = null;
  };
  void promise.then(release, release);
}

/** One round of the engine; see {@link runAutoPull}. */
async function pullRound(scope: ReadonlySet<number> | null, preloaded?: Repo[]): Promise<number[]> {
  try {
    const repos = preloaded ?? (await ipc.listRepos());
    const ids = candidates(repos, scope);
    if (ids.length === 0) return [];

    const names = new Map(repos.map((r) => [r.id, r.name]));
    const results = await ipc.gitPullFfMany(ids);
    const pulled: number[] = [];

    for (const result of results) {
      const name = names.get(result.repo_id) ?? "Repo";
      if (result.status === "pulled") {
        pulled.push(result.repo_id);
        // Reuse the manual pull's one-line summary (#76) rather than dumping
        // git's multi-line report into a toast.
        toast.success(`${name}: ${summarizePull(result.output ?? "")}`);
      }
      if (SILENT_STATUSES.has(result.status)) {
        // A good (or irrelevant) outcome clears the repo's warning memory, so a
        // later recurrence of the same problem is announced again.
        lastWarned.delete(result.repo_id);
      } else {
        warnOnce(result.repo_id, name, result.status, result.error ?? undefined);
      }
    }
    return pulled;
  } catch {
    // Background work stays quiet on failure, like the auto-fetch cycle — the
    // manual pull button is where errors are surfaced loudly.
    return [];
  }
}

/**
 * Reset the module's cross-round memory (warning history + in-flight guard).
 * Exists for tests, which need each case to start from a clean slate; nothing in
 * the app calls it — the state is process-lifetime by design.
 */
export function resetAutoPullState() {
  lastWarned.clear();
  inFlight = null;
}
