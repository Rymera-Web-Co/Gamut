import { ArrowDownToLine, Check } from "lucide-react";

import { ContextMenuItem } from "@/components/ui/context-menu";
import type { Repo } from "@/lib/ipc";

import { useSetRepoAutoPull } from "./api";

/**
 * The repo context menu's auto-pull opt-in (#299) — a checkable item that flips
 * `Repo.auto_pull`, so the app keeps this repo fast-forwarded when it falls behind
 * (only ever a clean fast-forward; see `lib/autoPull.ts`).
 *
 * Its own module rather than another export from `RepoSidebar.tsx`: the state it
 * shows and the value it writes are this feature's on/off switch, so it gets a
 * component test, and testing it shouldn't mean importing the whole sidebar (and
 * stubbing everything that sidebar reaches for at import time).
 */
export function AutoPullMenuItem({ repo, onDone }: { repo: Repo; onDone: () => void }) {
  const setAutoPull = useSetRepoAutoPull();
  const label = repo.auto_pull ? "Auto-pull: on" : "Auto-pull: off";
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
