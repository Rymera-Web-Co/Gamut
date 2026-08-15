import { ArrowDownToLine, Check } from "lucide-react";

import { ContextMenuItem } from "@/components/ui/context-menu";
import type { Repo } from "@/lib/ipc";
import { useSettings } from "@/lib/settings";

import { useSetRepoAutoPull } from "./api";

/**
 * The repo context menu's auto-pull opt-in (#299) — a checkable item that flips
 * `Repo.auto_pull`, so the app keeps this repo fast-forwarded when it falls behind
 * (only ever a clean fast-forward; see `lib/autoPull.ts`).
 *
 * Its own module rather than another export from the sidebar: the state it
 * shows and the value it writes are this feature's on/off switch, so it gets a
 * component test, and testing it shouldn't mean importing the whole sidebar (and
 * stubbing everything that sidebar reaches for at import time).
 */
export function AutoPullMenuItem({ repo, onDone }: { repo: Repo; onDone: () => void }) {
  const setAutoPull = useSetRepoAutoPull();
  // Auto-pull follows the global Auto-fetch setting (it is the one master switch
  // for background git work). Saying so *here* is what keeps that dependency from
  // being invisible: otherwise turning this on with Auto-fetch off looks broken.
  const backgroundSyncOn = useSettings((s) => s.values.autoFetch);
  const label = repo.auto_pull
    ? backgroundSyncOn
      ? "Auto-pull: on"
      : "Auto-pull: on (paused — Auto-fetch is off)"
    : "Auto-pull: off";
  return (
    <ContextMenuItem
      onClick={() => {
        setAutoPull.mutate({ repoId: repo.id, enabled: !repo.auto_pull });
        onDone();
      }}
    >
      {/* Decorative: the item's text already states the state, so announcing the
          icon too would read as "Auto-pull off, Auto-pull: off". */}
      {repo.auto_pull ? <Check aria-hidden="true" /> : <ArrowDownToLine aria-hidden="true" />}
      {label}
    </ContextMenuItem>
  );
}
