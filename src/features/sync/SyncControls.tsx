import { useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { PublishBranchActions, PublishBranchMessage } from "@/features/sync/PublishBranchConfirm";
import { branchAwaitingPublish } from "@/features/sync/pushGate";
import { useSyncActions } from "@/features/sync/useSyncActions";

export function SyncControls({
  repoId,
  ahead = 0,
  behind = 0,
}: {
  repoId: number;
  ahead?: number;
  behind?: number;
}) {
  const { pull, push, busy } = useSyncActions(repoId);

  // The branch this click would publish, once resolved — non-null while the
  // confirmation is open (#300). Local state, so it dies with the row rather
  // than surviving a sidebar toggle and re-opening unprompted later.
  const [publishing, setPublishing] = useState<string | null>(null);
  // The pre-push check is a round trip; hold the buttons through it so a second
  // click can't start a push while the first is still deciding.
  const [checking, setChecking] = useState(false);
  const pushButton = useRef<HTMLButtonElement>(null);
  const controls = useRef<HTMLDivElement>(null);

  async function onPush() {
    // With the confirmation already up, the button is its toggle — don't spend
    // another round trip re-asking the question that's on screen.
    if (publishing != null) {
      setPublishing(null);
      return;
    }
    setChecking(true);
    try {
      const branch = await branchAwaitingPublish(repoId);
      if (branch) setPublishing(branch);
      else push.mutate();
    } finally {
      setChecking(false);
    }
  }

  return (
    // `tabIndex={-1}` so focus has somewhere to land when the popover closes
    // while the push button is disabled (mid-push) — see `onCloseAutoFocus`.
    <div ref={controls} tabIndex={-1} className="flex items-center outline-none">
      <Button
        size="sm"
        variant="ghost"
        className="h-6 gap-0.5 px-1.5 text-[11px] [&_svg]:size-3"
        title="Pull (⌘⇧P)"
        disabled={busy || checking}
        onClick={() => pull.mutate()}
      >
        {pull.isPending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <ArrowDownToLine className="size-3" />
        )}
        {behind > 0 && <span>{behind}</span>}
      </Button>
      {/* Anchored, not triggered: whether this click pushes or asks is the
          handler's call, so the button must not also toggle the popover. */}
      <Popover open={publishing != null} onOpenChange={(open) => !open && setPublishing(null)}>
        <PopoverAnchor asChild>
          <Button
            ref={pushButton}
            size="sm"
            variant="ghost"
            className="h-6 gap-0.5 px-1.5 text-[11px] [&_svg]:size-3"
            title="Push (⌘⇧K)"
            disabled={busy || checking}
            onClick={onPush}
          >
            {push.isPending || checking ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <ArrowUpFromLine className="size-3" />
            )}
            {ahead > 0 && <span>{ahead}</span>}
          </Button>
        </PopoverAnchor>
        <PopoverContent
          align="end"
          aria-label="Publish branch to origin"
          className="w-64 space-y-2 p-3 text-xs"
          // An Anchor isn't a Trigger, so Radix's "focus the trigger on close"
          // finds nothing and suppresses the default restore — leaving focus on
          // <body>. Put it back on the button the popover belongs to, or on the
          // control group when confirming has just disabled that button.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const button = pushButton.current;
            (button?.disabled ? controls.current : button)?.focus();
          }}
          // Likewise, a click on the anchor would dismiss and then immediately
          // re-open via the button's own handler. Let the button toggle instead.
          onInteractOutside={(e) => {
            if (pushButton.current?.contains(e.target as Node)) e.preventDefault();
          }}
        >
          {publishing && (
            <>
              <PublishBranchMessage branch={publishing} />
              <PublishBranchActions
                onCancel={() => setPublishing(null)}
                onConfirm={() => {
                  setPublishing(null);
                  push.mutate();
                }}
              />
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
