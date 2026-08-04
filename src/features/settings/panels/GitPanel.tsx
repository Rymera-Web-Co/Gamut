import {
  Divider,
  Field,
  NumberField,
  PanelTitle,
  Segmented,
  TextField,
  Toggle,
  useSetting,
} from "../controls";

export function GitPanel() {
  const [baseBranchPrecedence, setBase] = useSetting("baseBranchPrecedence");
  const [protectedBranches, setProtected] = useSetting("protectedBranches");
  const [scanDepth, setScanDepth] = useSetting("scanDepth");
  const [pruneDirs, setPruneDirs] = useSetting("pruneDirs");
  const [watchDebounceMs, setWatchDebounce] = useSetting("watchDebounceMs");
  const [mergeStrategy, setMergeStrategy] = useSetting("mergeStrategy");
  const [autoCleanupAfterMerge, setAutoCleanup] = useSetting("autoCleanupAfterMerge");
  const [autoFetch, setAutoFetch] = useSetting("autoFetch");
  const [autoFetchInterval, setAutoFetchInterval] = useSetting("autoFetchIntervalMinutes");
  const [showSyncedRoot, setShowSyncedRoot] = useSetting("showSyncedRoot");

  return (
    <div>
      <PanelTitle>Git &amp; Repos</PanelTitle>
      <Field
        label="Base-branch precedence"
        hint="Comma-separated; tried in order for branch-vs-base reviews."
      >
        <TextField value={baseBranchPrecedence} onChange={setBase} wide />
      </Field>
      <Field label="Protected branches" hint="Never reported or deleted by branch cleanup.">
        <TextField value={protectedBranches} onChange={setProtected} wide />
      </Field>
      <Divider />
      <Field label="Folder discovery depth">
        <NumberField value={scanDepth} onChange={setScanDepth} min={1} max={20} suffix="levels" />
      </Field>
      <Field label="Discovery prune list" hint="Directory names skipped while scanning for repos.">
        <TextField value={pruneDirs} onChange={setPruneDirs} wide />
      </Field>
      <Field
        label="Show synced folder root"
        hint="For groups synced to a folder, show that folder itself as a browsable entry (tagged “root”), alongside the repos and subfolders discovered inside it."
      >
        <Toggle checked={showSyncedRoot} onChange={setShowSyncedRoot} />
      </Field>
      <Divider />
      <Field label="File watcher debounce" hint="Applied at startup — restart to take effect.">
        <NumberField
          value={watchDebounceMs}
          onChange={setWatchDebounce}
          min={50}
          max={5000}
          step={50}
          suffix="ms"
        />
      </Field>
      <Field label="Default merge strategy">
        <Segmented
          value={mergeStrategy}
          onChange={setMergeStrategy}
          options={[
            { value: "merge", label: "Merge" },
            { value: "squash", label: "Squash" },
            { value: "rebase", label: "Rebase" },
          ]}
        />
      </Field>
      <Field
        label="Clean up after merging a PR"
        hint="After merging, check out the base branch and delete the merged local branch (only when its remote branch was auto-deleted). Protected branches are never deleted."
      >
        <Toggle checked={autoCleanupAfterMerge} onChange={setAutoCleanup} />
      </Field>
      <Divider />
      <Field
        label="Auto-fetch repositories"
        hint="Periodically fetch all repos in the background so ahead/behind counts and branches stay current. Also the master switch for per-repo auto-pull — with this off, no background git work runs at all."
      >
        <Toggle checked={autoFetch} onChange={setAutoFetch} />
      </Field>
      {autoFetch && (
        <Field label="Auto-fetch interval">
          <NumberField
            value={autoFetchInterval}
            onChange={setAutoFetchInterval}
            min={1}
            max={120}
            suffix="min"
          />
        </Field>
      )}
    </div>
  );
}
