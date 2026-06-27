import { useState, type ReactElement } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, ChevronRight, CircleDot, Loader2, RotateCw } from "lucide-react";

import { usePrDetails, useRequestReview } from "./api";
import { Avatar, labelTextColor, ReviewerStatusIcon } from "./reviewShared";
import { toast } from "@/store/toast";
import { cn } from "@/lib/utils";

/** Whether a reviewer has already submitted a review — GitHub only allows
 * re-requesting a review from these. A still-PENDING reviewer (requested but
 * not yet reviewed) is rejected by the API, so the control is hidden for them. */
function hasReviewed(state: string): boolean {
  return state !== "PENDING";
}

function DetailsSection({ title, children }: { title: string; children: ReactElement | string }) {
  return (
    <div className="px-3 py-2">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
        {title}
      </div>
      {children}
    </div>
  );
}

export function PrDetailsCard({ repoId, number }: { repoId: number; number: number }) {
  const details = usePrDetails(repoId, number);
  const requestReview = useRequestReview(repoId);
  const [open, setOpen] = useState(true);
  const d = details.data;

  function reRequest(login: string) {
    requestReview.mutate(
      { number, reviewers: [login] },
      {
        onSuccess: () => toast.success(`Re-review requested from ${login}`),
        onError: (e) => toast.error(String(e)),
      },
    );
  }
  const empty = (text: string) => (
    <span className="text-xs text-[var(--color-muted-foreground)]">{text}</span>
  );

  return (
    <div className="rounded-md border">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 border-b bg-[var(--color-sidebar)] px-3 py-1.5 text-xs font-semibold"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        Details
        {details.isFetching && (
          <Loader2 className="size-3 animate-spin text-[var(--color-muted-foreground)]" />
        )}
      </button>

      {open && details.isError && (
        <p className="px-3 py-2 text-xs text-[var(--color-destructive)]">{String(details.error)}</p>
      )}

      {open && !d && !details.isError && (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-muted-foreground)]">
          <Loader2 className="size-3 animate-spin" /> Loading…
        </div>
      )}

      {open && d && (
        <div className="divide-y text-sm">
          <DetailsSection title="Reviewers">
            {d.reviewers.length === 0 ? (
              empty("No reviewers")
            ) : (
              <div className="flex flex-col gap-1.5">
                {d.reviewers.map((r) => {
                  const inFlight =
                    requestReview.isPending && requestReview.variables?.reviewers?.[0] === r.login;
                  return (
                    <div key={r.login} className="flex items-center gap-2">
                      <Avatar src={r.avatar} name={r.login} size={18} />
                      <span className="min-w-0 flex-1 truncate">{r.login}</span>
                      {/* A pending re-request shows a static indicator; an eligible
                          reviewer who isn't already re-requested gets a button to
                          send one. Reviewers who haven't reviewed yet (PENDING) are
                          rejected by the API, so no control is offered. */}
                      {r.re_requested ? (
                        <span title="Re-review requested">
                          <RotateCw className="size-3.5 text-[var(--color-muted-foreground)]" />
                        </span>
                      ) : (
                        hasReviewed(r.state) && (
                          <button
                            type="button"
                            disabled={inFlight}
                            onClick={() => reRequest(r.login)}
                            title={`Request re-review from ${r.login}`}
                            aria-label={`Request re-review from ${r.login}`}
                            className="text-[var(--color-muted-foreground)] transition-colors hover:text-[var(--color-foreground)] disabled:opacity-50"
                          >
                            {inFlight ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <RotateCw className="size-3.5" />
                            )}
                          </button>
                        )
                      )}
                      <span title={r.state.toLowerCase().replace("_", " ")}>
                        <ReviewerStatusIcon state={r.state} />
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </DetailsSection>

          <DetailsSection title="Assignees">
            {d.assignees.length === 0 ? (
              empty("No one")
            ) : (
              <div className="flex flex-wrap gap-2">
                {d.assignees.map((a) => (
                  <span key={a.login} className="flex items-center gap-1">
                    <Avatar src={a.avatar} name={a.login} size={18} />
                    {a.login}
                  </span>
                ))}
              </div>
            )}
          </DetailsSection>

          <DetailsSection title="Labels">
            {d.labels.length === 0 ? (
              empty("None yet")
            ) : (
              <div className="flex flex-wrap gap-1">
                {d.labels.map((l) => (
                  <span
                    key={l.name}
                    style={{
                      backgroundColor: `#${l.color}`,
                      color: labelTextColor(l.color),
                    }}
                    className="rounded-full px-2 py-0.5 text-xs font-medium"
                  >
                    {l.name}
                  </span>
                ))}
              </div>
            )}
          </DetailsSection>

          <DetailsSection title="Milestone">
            {d.milestone ? d.milestone : empty("No milestone")}
          </DetailsSection>

          <DetailsSection title="Development">
            {d.linked_issues.length === 0 ? (
              empty("No linked issues")
            ) : (
              <div className="flex flex-col gap-1">
                {d.linked_issues.map((i) => (
                  <button
                    key={i.number}
                    title={i.url}
                    onClick={() => openUrl(i.url).catch(() => {})}
                    className="flex items-center gap-2 text-left hover:underline"
                  >
                    <CircleDot
                      className={cn(
                        "size-3.5 shrink-0",
                        i.state === "OPEN" ? "text-[#16a34a]" : "text-[#8957e5]",
                      )}
                    />
                    <span className="min-w-0 truncate">
                      #{i.number} {i.title}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </DetailsSection>
        </div>
      )}
    </div>
  );
}
