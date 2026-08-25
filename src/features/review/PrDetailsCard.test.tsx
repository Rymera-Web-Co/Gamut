import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

import type { PrDetails } from "@/lib/ipc";

// PrDetailsCard talks to GitHub through the ./api hooks; stand each in so the
// card (and the PeoplePicker it wires up) render without a Tauri backend (#334).
const COLLABORATORS = [
  { login: "alice", avatar: "https://example.com/alice.png" },
  { login: "bob", avatar: "https://example.com/bob.png" },
  { login: "carol", avatar: "https://example.com/carol.png" },
];

const collaboratorsState: {
  data: typeof COLLABORATORS | undefined;
  isError: boolean;
  isPending: boolean;
  isFetching: boolean;
} = { data: COLLABORATORS, isError: false, isPending: false, isFetching: false };

const authState: { data: { login: string } | undefined } = { data: undefined };

const requestReviewMutate = vi.fn();
const removeReviewRequestMutate = vi.fn();
const addAssigneesMutate = vi.fn();
const removeAssigneesMutate = vi.fn();

type ReviewerMutation = {
  mutate: typeof requestReviewMutate;
  isPending: boolean;
  variables: { reviewers?: string[] } | undefined;
};
type AssigneeMutation = {
  mutate: typeof addAssigneesMutate;
  isPending: boolean;
  variables: { assignees?: string[] } | undefined;
};

const useRequestReview = vi.fn<(repoId: number) => ReviewerMutation>();
const useRemoveReviewRequest = vi.fn<(repoId: number) => ReviewerMutation>();
const useAddAssignees = vi.fn<(repoId: number) => AssigneeMutation>();
const useRemoveAssignees = vi.fn<(repoId: number) => AssigneeMutation>();

/** Re-install the idle default for every mutation hook. `beforeEach` uses
 * `mockReset()` (not `mockClear()`) so a per-test `mockReturnValue` override
 * cannot leak into the tests that follow it, which means the defaults have to
 * be put back each time (#334). */
function installMutationDefaults() {
  useRequestReview.mockReturnValue({
    mutate: requestReviewMutate,
    isPending: false,
    variables: undefined,
  });
  useRemoveReviewRequest.mockReturnValue({
    mutate: removeReviewRequestMutate,
    isPending: false,
    variables: undefined,
  });
  useAddAssignees.mockReturnValue({
    mutate: addAssigneesMutate,
    isPending: false,
    variables: undefined,
  });
  useRemoveAssignees.mockReturnValue({
    mutate: removeAssigneesMutate,
    isPending: false,
    variables: undefined,
  });
}

let detailsData: PrDetails | undefined;
const detailsState = {
  get data() {
    return detailsData;
  },
  isFetching: false,
  isError: false,
  error: null as unknown,
};

vi.mock("./api", () => ({
  usePrDetails: () => detailsState,
  useRequestReview: (repoId: number) => useRequestReview(repoId),
  useRemoveReviewRequest: (repoId: number) => useRemoveReviewRequest(repoId),
  useAddAssignees: (repoId: number) => useAddAssignees(repoId),
  useRemoveAssignees: (repoId: number) => useRemoveAssignees(repoId),
  useCollaborators: () => collaboratorsState,
  useGithubAuth: () => authState,
}));

vi.mock("@/store/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "@/store/toast";
import { PrDetailsCard } from "./PrDetailsCard";

const REPO_ID = 42;
const NUMBER = 7;

function baseDetails(overrides: Partial<PrDetails> = {}): PrDetails {
  return {
    reviewers: [],
    assignees: [],
    labels: [],
    milestone: null,
    linked_issues: [],
    merge: {
      id: "",
      review_decision: null,
      mergeable: "UNKNOWN",
      merge_state_status: "UNKNOWN",
      is_draft: false,
      check_rollup: null,
      checks: [],
    },
    ...overrides,
  };
}

function renderCard() {
  return render(<PrDetailsCard repoId={REPO_ID} number={NUMBER} />);
}

/** Scope queries to the open picker popover, since a login can also appear in
 * the card body (the Reviewers/Assignees list) once it's checked. */
function picker() {
  return within(screen.getByRole("dialog"));
}

describe("PrDetailsCard reviewers/assignees editing (#334)", () => {
  beforeEach(() => {
    collaboratorsState.data = COLLABORATORS;
    collaboratorsState.isError = false;
    collaboratorsState.isPending = false;
    collaboratorsState.isFetching = false;
    authState.data = undefined;
    detailsData = baseDetails();
    detailsState.isFetching = false;
    detailsState.isError = false;
    requestReviewMutate.mockReset();
    removeReviewRequestMutate.mockReset();
    addAssigneesMutate.mockReset();
    removeAssigneesMutate.mockReset();
    useRequestReview.mockReset();
    useRemoveReviewRequest.mockReset();
    useAddAssignees.mockReset();
    useRemoveAssignees.mockReset();
    installMutationDefaults();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it("A1: opening the Reviewers picker lists every collaborator login", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /edit reviewers/i }));
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    expect(screen.getByText("bob")).toBeInTheDocument();
    expect(screen.getByText("carol")).toBeInTheDocument();
  });

  it("A2: each picker row shows that collaborator's own avatar", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /edit reviewers/i }));
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());

    const aliceRow = screen.getByText("alice").closest('[role="checkbox"]') as HTMLElement;
    const bobRow = screen.getByText("bob").closest('[role="checkbox"]') as HTMLElement;
    expect(aliceRow.querySelector("img")).toHaveAttribute("src", COLLABORATORS[0].avatar);
    expect(bobRow.querySelector("img")).toHaveAttribute("src", COLLABORATORS[1].avatar);
  });

  it("A3a: checks exactly outstanding reviewers, leaving a non-reviewer assignee unchecked", async () => {
    detailsData = baseDetails({
      reviewers: [
        { login: "alice", avatar: null, state: "PENDING", re_requested: false },
        { login: "bob", avatar: null, state: "APPROVED", re_requested: true },
        { login: "carol", avatar: null, state: "APPROVED", re_requested: false },
      ],
      assignees: [{ login: "carol", avatar: null }],
    });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /edit reviewers/i }));
    await waitFor(() => expect(picker().getByText("alice")).toBeInTheDocument());

    const rowFor = (login: string) => picker().getByText(login).closest('[role="checkbox"]');
    expect(rowFor("alice")).toHaveAttribute("aria-checked", "true");
    expect(rowFor("bob")).toHaveAttribute("aria-checked", "true");
    // carol is an assignee, not a pending/re-requested reviewer.
    expect(rowFor("carol")).toHaveAttribute("aria-checked", "false");
  });

  it("A3b: checks exactly current assignees, leaving a non-assignee reviewer unchecked", async () => {
    detailsData = baseDetails({
      reviewers: [{ login: "bob", avatar: null, state: "APPROVED", re_requested: false }],
      assignees: [{ login: "alice", avatar: null }],
    });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /edit assignees/i }));
    await waitFor(() => expect(picker().getByText("alice")).toBeInTheDocument());

    const rowFor = (login: string) => picker().getByText(login).closest('[role="checkbox"]');
    expect(rowFor("alice")).toHaveAttribute("aria-checked", "true");
    expect(rowFor("bob")).toHaveAttribute("aria-checked", "false");
  });

  it("A4/A8: selecting unchecked reviewers calls request-review per login, and only that mutation", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /edit reviewers/i }));
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());

    fireEvent.click(screen.getByText("alice"));
    fireEvent.click(screen.getByText("bob"));

    expect(useRequestReview).toHaveBeenCalledWith(REPO_ID);
    expect(requestReviewMutate).toHaveBeenNthCalledWith(
      1,
      { number: NUMBER, reviewers: ["alice"] },
      expect.anything(),
    );
    expect(requestReviewMutate).toHaveBeenNthCalledWith(
      2,
      { number: NUMBER, reviewers: ["bob"] },
      expect.anything(),
    );
    expect(removeReviewRequestMutate).not.toHaveBeenCalled();
    expect(addAssigneesMutate).not.toHaveBeenCalled();
    expect(removeAssigneesMutate).not.toHaveBeenCalled();
  });

  it("A5/A8: unchecking a reviewer with an outstanding request calls remove-review-request only", async () => {
    detailsData = baseDetails({
      reviewers: [{ login: "alice", avatar: null, state: "PENDING", re_requested: false }],
    });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /edit reviewers/i }));
    await waitFor(() => expect(picker().getByText("alice")).toBeInTheDocument());

    fireEvent.click(picker().getByText("alice"));

    expect(removeReviewRequestMutate).toHaveBeenCalledWith(
      { number: NUMBER, reviewers: ["alice"] },
      expect.anything(),
    );
    expect(requestReviewMutate).not.toHaveBeenCalled();
    expect(addAssigneesMutate).not.toHaveBeenCalled();
    expect(removeAssigneesMutate).not.toHaveBeenCalled();
  });

  it("A6/A8: selecting an unchecked assignee calls add-assignees only, with the full args", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /edit assignees/i }));
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());

    fireEvent.click(screen.getByText("alice"));

    expect(useAddAssignees).toHaveBeenCalledWith(REPO_ID);
    expect(addAssigneesMutate).toHaveBeenCalledWith(
      { number: NUMBER, assignees: ["alice"] },
      expect.anything(),
    );
    expect(requestReviewMutate).not.toHaveBeenCalled();
    expect(removeReviewRequestMutate).not.toHaveBeenCalled();
    expect(removeAssigneesMutate).not.toHaveBeenCalled();
  });

  it("A7/A8: unchecking a current assignee calls remove-assignees only, with the full args", async () => {
    detailsData = baseDetails({ assignees: [{ login: "bob", avatar: null }] });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /edit assignees/i }));
    await waitFor(() => expect(picker().getByText("bob")).toBeInTheDocument());

    fireEvent.click(picker().getByText("bob"));

    expect(removeAssigneesMutate).toHaveBeenCalledWith(
      { number: NUMBER, assignees: ["bob"] },
      expect.anything(),
    );
    expect(requestReviewMutate).not.toHaveBeenCalled();
    expect(removeReviewRequestMutate).not.toHaveBeenCalled();
    expect(addAssigneesMutate).not.toHaveBeenCalled();
  });

  it("A10: the card re-renders reviewers/assignees from new details data", async () => {
    detailsData = baseDetails();
    const { rerender } = renderCard();
    expect(screen.getByText("No reviewers")).toBeInTheDocument();
    expect(screen.getByText("No one")).toBeInTheDocument();

    detailsData = baseDetails({
      reviewers: [{ login: "alice", avatar: null, state: "PENDING", re_requested: false }],
      assignees: [{ login: "bob", avatar: null }],
    });
    rerender(<PrDetailsCard repoId={REPO_ID} number={NUMBER} />);

    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  it("A11: the existing re-request button is unchanged for a reviewed, non-re-requested reviewer", () => {
    detailsData = baseDetails({
      reviewers: [{ login: "dave", avatar: null, state: "APPROVED", re_requested: false }],
    });
    renderCard();

    const button = screen.getByRole("button", { name: /request re-review from dave/i });
    fireEvent.click(button);
    expect(requestReviewMutate).toHaveBeenCalledWith(
      { number: NUMBER, reviewers: ["dave"] },
      expect.anything(),
    );
  });

  it("A12: no re-request control for a PENDING reviewer; a static indicator replaces it when re-requested", () => {
    detailsData = baseDetails({
      reviewers: [
        { login: "pending-guy", avatar: null, state: "PENDING", re_requested: false },
        { login: "re-req-guy", avatar: null, state: "APPROVED", re_requested: true },
      ],
    });
    renderCard();

    expect(
      screen.queryByRole("button", { name: /request re-review from pending-guy/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /request re-review from re-req-guy/i })).toBeNull();
    expect(screen.getByTitle("Re-review requested")).toBeInTheDocument();
  });

  it("A14: an errored collaborators fetch renders a non-crashing state, and re-request still works", async () => {
    collaboratorsState.data = undefined;
    collaboratorsState.isError = true;
    detailsData = baseDetails({
      reviewers: [{ login: "dave", avatar: null, state: "APPROVED", re_requested: false }],
    });
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: /edit reviewers/i }));
    await waitFor(() => expect(screen.getByText(/couldn.t load/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /request re-review from dave/i }));
    expect(requestReviewMutate).toHaveBeenCalled();
  });

  it("A14: an empty collaborators list renders a non-crashing empty state", async () => {
    collaboratorsState.data = [];
    collaboratorsState.isError = false;
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: /edit reviewers/i }));
    await waitFor(() => expect(screen.getByText(/no collaborators/i)).toBeInTheDocument());
  });

  it("A15: a failed mutation surfaces a toast and applies no optimistic update", async () => {
    detailsData = baseDetails();
    // Simulate onError by having the mutate mock invoke the passed options.
    addAssigneesMutate.mockImplementation((_vars, opts) => {
      opts?.onError?.(new Error("nope"));
    });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /edit assignees/i }));
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());

    fireEvent.click(screen.getByText("alice"));

    expect(toast.error).toHaveBeenCalled();
    // No optimistic update: the card still reads from the (unchanged) mock data,
    // so alice's row is still unchecked.
    const row = screen.getByText("alice").closest('[role="checkbox"]');
    expect(row).toHaveAttribute("aria-checked", "false");
  });

  it("A16: while a mutation is pending for a login, its row is disabled", async () => {
    useAddAssignees.mockReturnValue({
      mutate: addAssigneesMutate,
      isPending: true,
      variables: { assignees: ["alice"] },
    });
    detailsData = baseDetails();
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /edit assignees/i }));
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());

    const row = screen.getByText("alice").closest('[role="checkbox"]');
    expect(row).toBeDisabled();
  });

  it("A16b: the pending override from A16 does not leak into later tests", async () => {
    // Guard for the `mockReset()` + re-installed defaults in `beforeEach`:
    // with the old `mockClear()` this row was still disabled here (#334).
    detailsData = baseDetails();
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /edit assignees/i }));
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());

    expect(screen.getByText("alice").closest('[role="checkbox"]')).not.toBeDisabled();
  });

  it("A16c: a row is disabled when its login is anywhere in the in-flight list", async () => {
    useAddAssignees.mockReturnValue({
      mutate: addAssigneesMutate,
      isPending: true,
      variables: { assignees: ["alice", "bob"] },
    });
    detailsData = baseDetails();
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /edit assignees/i }));
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());

    // "bob" is not first in the list, but is still mid-flight (#334).
    expect(screen.getByText("bob").closest('[role="checkbox"]')).toBeDisabled();
    expect(screen.getByText("carol").closest('[role="checkbox"]')).not.toBeDisabled();
  });

  it("B3: each successful toggle reports what happened", async () => {
    addAssigneesMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    removeAssigneesMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    requestReviewMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    removeReviewRequestMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    detailsData = baseDetails({
      reviewers: [{ login: "bob", avatar: null, state: "PENDING", re_requested: false }],
      assignees: [{ login: "carol", avatar: null }],
    });
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: /edit reviewers/i }));
    await waitFor(() => expect(picker().getByText("alice")).toBeInTheDocument());
    fireEvent.click(picker().getByText("alice"));
    fireEvent.click(picker().getByText("bob"));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: /edit assignees/i }));
    await waitFor(() => expect(picker().getByText("alice")).toBeInTheDocument());
    fireEvent.click(picker().getByText("alice"));
    fireEvent.click(picker().getByText("carol"));

    const messages = vi.mocked(toast.success).mock.calls.map((c) => c[0]);
    expect(messages).toEqual([
      "Requested a review from alice",
      "Removed the review request for bob",
      "Assigned alice",
      "Unassigned carol",
    ]);
  });

  it("A5/B1: a reviewer who already reviewed is a disabled row with a reason, not an empty box", async () => {
    detailsData = baseDetails({
      reviewers: [{ login: "carol", avatar: null, state: "APPROVED", re_requested: false }],
    });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /edit reviewers/i }));
    await waitFor(() => expect(picker().getByText("carol")).toBeInTheDocument());

    const row = picker().getByText("carol").closest('[role="checkbox"]') as HTMLElement;
    expect(row).toBeDisabled();
    expect(row).toHaveTextContent("already reviewed");
    fireEvent.click(row);
    expect(requestReviewMutate).not.toHaveBeenCalled();
  });

  it("B1: a re-requested reviewer stays checked and enabled", async () => {
    detailsData = baseDetails({
      reviewers: [{ login: "carol", avatar: null, state: "APPROVED", re_requested: true }],
    });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /edit reviewers/i }));
    await waitFor(() => expect(picker().getByText("carol")).toBeInTheDocument());

    const row = picker().getByText("carol").closest('[role="checkbox"]');
    expect(row).toHaveAttribute("aria-checked", "true");
    expect(row).not.toBeDisabled();
  });

  it("B2: the PR author and the signed-in user are disabled in the reviewers picker", async () => {
    authState.data = { login: "bob" };
    render(<PrDetailsCard repoId={REPO_ID} number={NUMBER} author="alice" />);
    fireEvent.click(screen.getByRole("button", { name: /edit reviewers/i }));
    await waitFor(() => expect(picker().getByText("alice")).toBeInTheDocument());

    const authorRow = picker().getByText("alice").closest('[role="checkbox"]') as HTMLElement;
    const selfRow = picker().getByText("bob").closest('[role="checkbox"]') as HTMLElement;
    expect(authorRow).toBeDisabled();
    expect(authorRow).toHaveTextContent("PR author");
    expect(selfRow).toBeDisabled();
    expect(selfRow).toHaveTextContent(/self-review/i);
    expect(picker().getByText("carol").closest('[role="checkbox"]')).not.toBeDisabled();
  });

  it("B2: the assignees picker still offers the author and the signed-in user", async () => {
    authState.data = { login: "bob" };
    render(<PrDetailsCard repoId={REPO_ID} number={NUMBER} author="alice" />);
    fireEvent.click(screen.getByRole("button", { name: /edit assignees/i }));
    await waitFor(() => expect(picker().getByText("alice")).toBeInTheDocument());

    expect(picker().getByText("alice").closest('[role="checkbox"]')).not.toBeDisabled();
    expect(picker().getByText("bob").closest('[role="checkbox"]')).not.toBeDisabled();
  });
});
