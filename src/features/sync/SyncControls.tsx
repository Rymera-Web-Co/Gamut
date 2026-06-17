import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Loader2,
  RefreshCw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
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
  const { fetch, pull, push, busy } = useSyncActions(repoId);

  return (
    <div className="flex items-center">
      <Button
        size="sm"
        variant="ghost"
        className="h-6 gap-0.5 px-1.5 text-[11px] [&_svg]:size-3"
        title="Fetch all remotes (⌘⌥F)"
        disabled={busy}
        onClick={() => fetch.mutate()}
      >
        {fetch.isPending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <RefreshCw className="size-3" />
        )}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 gap-0.5 px-1.5 text-[11px] [&_svg]:size-3"
        title="Pull (⌘⇧P)"
        disabled={busy}
        onClick={() => pull.mutate()}
      >
        {pull.isPending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <ArrowDownToLine className="size-3" />
        )}
        {behind > 0 && <span>{behind}</span>}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 gap-0.5 px-1.5 text-[11px] [&_svg]:size-3"
        title="Push (⌘⇧K)"
        disabled={busy}
        onClick={() => push.mutate()}
      >
        {push.isPending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <ArrowUpFromLine className="size-3" />
        )}
        {ahead > 0 && <span>{ahead}</span>}
      </Button>
    </div>
  );
}
