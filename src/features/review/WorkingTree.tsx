import { useEffect, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  FileCheck2,
  Loader2,
  Minus,
  Pencil,
  Plus,
  Trash2,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { FileActionsMenu, type FileMenuTarget } from "@/components/FileActionsMenu";
import type { ContextMenuPosition } from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Panel, PanelGroup, ResizeHandle } from "@/components/ui/resizable";
import type { FileChange } from "@/lib/ipc";
import { CodeDiffEditor } from "@/components/MonacoEditor";
import { isDarkTheme, languageFor } from "@/lib/lang";
import { GITHUB_DARK } from "@/lib/monacoTheme";
import { useDiffEditorPrefs } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast";
import { useUiStore } from "@/store/ui";
import {
  useCommit,
  useDiscard,
  useStage,
  useStashAction,
  useStashList,
  useStashPush,
  useUnstage,
  useWorktreeFileDiff,
  useWorktreeStatus,
} from "./api";

type Selected = { file: FileChange; staged: boolean };

function statusColor(status: string): string {
  switch (status) {
    case "added":
      return "#16a34a";
    case "deleted":
      return "#dc2626";
    case "renamed":
      return "#2563eb";
    default:
      return "#a16207";
  }
}

/** One changed-file row with a stage/unstage affordance on the right. */
function ChangeRow({
  file,
  selected,
  onOpen,
  onAction,
  actionPending,
  staged,
  onDiscard,
  discardPending,
  onContextMenu,
}: {
  file: FileChange;
  selected: boolean;
  onOpen: () => void;
  onAction: () => void;
  actionPending: boolean;
  staged: boolean;
  /** When set (unstaged rows), shows a discard button that confirms first. */
  onDiscard?: () => void;
  discardPending?: boolean;
  onContextMenu: (pos: ContextMenuPosition) => void;
}) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;

  return (
    <div
      role="button"
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu({ x: e.clientX, y: e.clientY });
      }}
      title={file.path}
      className={cn(
        "group flex cursor-pointer items-center gap-2 py-1 pl-3 pr-2 text-sm",
        selected ? "bg-[var(--color-accent)]" : "hover:bg-[var(--color-accent)]",
      )}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-xs">
        <span className="text-[var(--color-muted-foreground)]">{dir}</span>
        {name}
      </span>
      {file.additions > 0 && (
        <span className="shrink-0 text-xs font-medium text-[#16a34a]">+{file.additions}</span>
      )}
      {file.deletions > 0 && (
        <span className="shrink-0 text-xs font-medium text-[#dc2626]">−{file.deletions}</span>
      )}
      <span
        className="w-3 shrink-0 text-center text-xs font-bold"
        style={{ color: statusColor(file.status) }}
        title={file.status}
      >
        {file.status[0].toUpperCase()}
      </span>
      {onDiscard && (
        <Popover open={confirmDiscard} onOpenChange={setConfirmDiscard}>
          <PopoverTrigger asChild>
            <button
              onClick={(e) => e.stopPropagation()}
              disabled={discardPending}
              title="Discard changes"
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-background)] hover:text-[var(--color-destructive)]",
                confirmDiscard ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
            >
              {discardPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Undo2 className="size-3.5" />
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 p-3" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm">
              Discard changes to <span className="font-mono font-medium">{name}</span>? This can't
              be undone.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmDiscard(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setConfirmDiscard(false);
                  onDiscard();
                }}
              >
                Discard
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onAction();
        }}
        disabled={actionPending}
        title={staged ? "Unstage" : "Stage"}
        className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--color-muted-foreground)] opacity-0 hover:bg-[var(--color-background)] hover:text-[var(--color-foreground)] group-hover:opacity-100"
      >
        {actionPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : staged ? (
          <Minus className="size-3.5" />
        ) : (
          <Plus className="size-3.5" />
        )}
      </button>
    </div>
  );
}

type HeaderAction = {
  label: string;
  icon: typeof Plus;
  onClick: () => void;
  disabled?: boolean;
};

function SectionHeader({
  title,
  count,
  action,
  confirm,
}: {
  title: string;
  count: number;
  action?: HeaderAction;
  /** A destructive action that asks for confirmation first. */
  confirm?: Omit<HeaderAction, "onClick"> & { message: string; onConfirm: () => void };
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-[var(--color-sidebar)] px-3 py-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
      <span>{title}</span>
      <span className="rounded-full bg-[var(--color-accent)] px-1.5 text-[10px]">{count}</span>
      {count > 0 && (action || confirm) && (
        <div className="ml-auto flex items-center gap-1">
          {action && (
            <button
              onClick={action.onClick}
              disabled={action.disabled}
              title={action.label}
              className="flex items-center rounded p-0.5 hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
            >
              <action.icon className="size-3.5" />
            </button>
          )}
          {confirm && (
            <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
              <PopoverTrigger asChild>
                <button
                  disabled={confirm.disabled}
                  title={confirm.label}
                  className="flex items-center rounded p-0.5 text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-destructive)]"
                >
                  <confirm.icon className="size-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 p-3">
                <p className="text-sm">{confirm.message}</p>
                <div className="mt-3 flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      setConfirmOpen(false);
                      confirm.onConfirm();
                    }}
                  >
                    {confirm.label}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
      )}
    </div>
  );
}

function StashBar({ repoId }: { repoId: number }) {
  const stashes = useStashList(repoId);
  const push = useStashPush(repoId);
  const pop = useStashAction(repoId, "pop");
  const apply = useStashAction(repoId, "apply");
  const drop = useStashAction(repoId, "drop");

  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [untracked, setUntracked] = useState(true);

  const list = stashes.data ?? [];

  function doPush() {
    push.mutate(
      { message: message.trim() || null, includeUntracked: untracked },
      {
        onSuccess: () => {
          setOpen(false);
          setMessage("");
          toast.success("Stashed changes");
        },
      },
    );
  }

  return (
    <div className="shrink-0 border-b">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" className="h-7">
              <Archive className="size-3.5" /> Stash
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 space-y-2 p-3">
            <div className="text-sm font-semibold">Stash changes</div>
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Optional message"
              className="w-full rounded-md border border-[var(--color-input)] bg-transparent px-2 py-1 text-sm"
            />
            <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
              <input
                type="checkbox"
                checked={untracked}
                onChange={(e) => setUntracked(e.target.checked)}
              />
              Include untracked files
            </label>
            <Button size="sm" className="w-full" disabled={push.isPending} onClick={doPush}>
              {push.isPending && <Loader2 className="animate-spin" />}
              Stash
            </Button>
          </PopoverContent>
        </Popover>
        <span className="text-xs text-[var(--color-muted-foreground)]">
          {list.length} stash{list.length === 1 ? "" : "es"}
        </span>
      </div>

      {list.length > 0 && (
        <div className="max-h-32 overflow-auto border-t">
          {list.map((s) => {
            const busy =
              (pop.isPending && pop.variables === s.index) ||
              (apply.isPending && apply.variables === s.index) ||
              (drop.isPending && drop.variables === s.index);
            return (
              <div
                key={s.index}
                className="group flex items-center gap-2 px-3 py-1 text-xs hover:bg-[var(--color-accent)]"
              >
                <span className="min-w-0 flex-1 truncate" title={s.message}>
                  {s.message}
                </span>
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin text-[var(--color-muted-foreground)]" />
                ) : (
                  <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
                    <button
                      title="Pop (apply and drop)"
                      onClick={() =>
                        pop.mutate(s.index, {
                          onSuccess: () => toast.success("Stash popped"),
                        })
                      }
                      className="flex size-5 items-center justify-center rounded hover:bg-[var(--color-background)]"
                    >
                      <ArchiveRestore className="size-3.5" />
                    </button>
                    <button
                      title="Apply (keep on stack)"
                      onClick={() =>
                        apply.mutate(s.index, {
                          onSuccess: () => toast.success("Stash applied"),
                        })
                      }
                      className="flex size-5 items-center justify-center rounded hover:bg-[var(--color-background)]"
                    >
                      <Check className="size-3.5" />
                    </button>
                    <button
                      title="Drop"
                      onClick={() =>
                        drop.mutate(s.index, {
                          onSuccess: () => toast.success("Stash dropped"),
                        })
                      }
                      className="flex size-5 items-center justify-center rounded text-[var(--color-destructive)] hover:bg-[var(--color-background)]"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CommitForm({ repoId, stagedCount }: { repoId: number; stagedCount: number }) {
  const commit = useCommit(repoId);
  const [message, setMessage] = useState("");
  const canCommit = stagedCount > 0 && message.trim().length > 0 && !commit.isPending;

  function doCommit() {
    if (!canCommit) return;
    commit.mutate(message.trim(), {
      onSuccess: (out) => {
        setMessage("");
        toast.success(out?.split("\n")[0] || "Committed");
      },
    });
  }

  return (
    <div className="shrink-0 space-y-2 border-b p-3">
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Commit message"
        rows={3}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter commits.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") doCommit();
        }}
        className="w-full resize-none rounded-md border border-[var(--color-input)] bg-transparent px-2 py-1.5 text-sm"
      />
      <Button size="sm" className="w-full" disabled={!canCommit} onClick={doCommit}>
        {commit.isPending && <Loader2 className="animate-spin" />}
        <Check />
        Commit
        {stagedCount > 0 ? ` ${stagedCount} file${stagedCount === 1 ? "" : "s"}` : ""}
      </Button>
    </div>
  );
}

export function WorkingTree({ repoId }: { repoId: number }) {
  const status = useWorktreeStatus(repoId);
  const stage = useStage(repoId);
  const unstage = useUnstage(repoId);
  const discard = useDiscard(repoId);
  const setView = useUiStore((s) => s.setView);
  const setFilesPath = useUiStore((s) => s.setFilesPath);
  const diffPrefs = useDiffEditorPrefs();
  const [selected, setSelected] = useState<Selected | null>(null);
  const [menu, setMenu] = useState<FileMenuTarget | null>(null);

  useEffect(() => {
    setSelected(null);
  }, [repoId]);

  const diff = useWorktreeFileDiff(
    repoId,
    selected?.file.path ?? null,
    selected?.staged ?? false,
    selected?.file.old_path,
  );

  if (status.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="animate-spin text-[var(--color-muted-foreground)]" />
      </div>
    );
  }
  if (status.isError) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--color-destructive)]">
        {String(status.error)}
      </div>
    );
  }

  const staged = status.data?.staged ?? [];
  const unstaged = status.data?.unstaged ?? [];

  return (
    <PanelGroup
      direction="horizontal"
      autoSaveId="gamut.layout.worktree"
      className="flex h-full min-h-0"
    >
      <Panel defaultSize={32} minSize={22} maxSize={60} className="flex min-w-0 flex-col">
        <CommitForm repoId={repoId} stagedCount={staged.length} />

        <StashBar repoId={repoId} />

        <div className="min-h-0 flex-1 overflow-auto">
          <SectionHeader
            title="Staged"
            count={staged.length}
            action={{
              label: "Unstage all",
              icon: Minus,
              disabled: unstage.isPending,
              onClick: () => {
                unstage.mutate(staged.map((f) => f.path));
                setSelected(null);
              },
            }}
          />
          {staged.map((f) => (
            <ChangeRow
              key={`s:${f.path}`}
              file={f}
              staged
              selected={selected?.staged === true && selected.file.path === f.path}
              onOpen={() => setSelected({ file: f, staged: true })}
              actionPending={unstage.isPending}
              onAction={() => {
                unstage.mutate([f.path]);
                setSelected({ file: f, staged: false });
              }}
              onContextMenu={(pos) => setMenu({ path: f.path, pos })}
            />
          ))}

          <SectionHeader
            title="Changes"
            count={unstaged.length}
            action={{
              label: "Stage all",
              icon: Plus,
              disabled: stage.isPending,
              onClick: () => {
                stage.mutate(unstaged.map((f) => f.path));
                setSelected(null);
              },
            }}
            confirm={{
              label: "Discard all",
              icon: Undo2,
              disabled: discard.isPending,
              message: `Discard changes to all ${unstaged.length} unstaged file${
                unstaged.length === 1 ? "" : "s"
              }? This can't be undone.`,
              onConfirm: () => {
                discard.mutate(unstaged.map((f) => f.path));
                setSelected((s) => (s?.staged === false ? null : s));
              },
            }}
          />
          {unstaged.map((f) => (
            <ChangeRow
              key={`u:${f.path}`}
              file={f}
              staged={false}
              selected={selected?.staged === false && selected.file.path === f.path}
              onOpen={() => setSelected({ file: f, staged: false })}
              actionPending={stage.isPending}
              onAction={() => {
                stage.mutate([f.path]);
                setSelected({ file: f, staged: true });
              }}
              discardPending={discard.isPending}
              onDiscard={() => {
                discard.mutate([f.path]);
                setSelected((s) => (s?.staged === false && s.file.path === f.path ? null : s));
              }}
              onContextMenu={(pos) => setMenu({ path: f.path, pos })}
            />
          ))}

          {staged.length === 0 && unstaged.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
              <FileCheck2 className="size-7 text-[var(--color-muted-foreground)]" />
              <p className="text-sm text-[var(--color-muted-foreground)]">Working tree clean.</p>
            </div>
          )}
        </div>
      </Panel>

      <ResizeHandle />

      <Panel className="min-w-0">
        <div className="flex h-full flex-col">
          {selected && (
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-muted-foreground)]">
                {selected.file.path}
              </span>
              {/* Deleted files no longer exist on disk, so there's nothing to edit. */}
              {selected.file.status !== "deleted" && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1.5"
                  title="Edit this file in the Files tab"
                  onClick={() => {
                    setFilesPath(selected.file.path);
                    setView("files");
                  }}
                >
                  <Pencil className="size-3.5" />
                  Edit
                </Button>
              )}
            </div>
          )}
          <div className="min-h-0 flex-1">
            {!selected ? (
              <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted-foreground)]">
                Select a file to see its diff.
              </div>
            ) : diff.isLoading || !diff.data ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="animate-spin text-[var(--color-muted-foreground)]" />
              </div>
            ) : diff.data.is_binary ? (
              <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted-foreground)]">
                Binary file — diff not shown.
              </div>
            ) : (
              <CodeDiffEditor
                height="100%"
                theme={isDarkTheme() ? GITHUB_DARK : "light"}
                language={languageFor(selected.file.path)}
                original={diff.data.old_text ?? ""}
                modified={diff.data.new_text ?? ""}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  ...diffPrefs,
                }}
              />
            )}
          </div>
        </div>
      </Panel>

      <FileActionsMenu repoId={repoId} target={menu} onClose={() => setMenu(null)} />
    </PanelGroup>
  );
}
