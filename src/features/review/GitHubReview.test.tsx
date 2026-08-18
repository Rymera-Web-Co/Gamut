import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// The popover talks to GitHub through the api hooks; stand in the three it
// uses so the own-PR guard can be exercised under jsdom.
const submitMutate = vi.fn();
const authState: { data: { logged_in: boolean; login: string } | null } = {
  data: { logged_in: true, login: "octocat" },
};
vi.mock("./api", () => ({
  useGithubAuth: () => authState,
  useSubmitReview: () => ({
    mutate: submitMutate,
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  }),
  useMentionables: () => ({ data: [] }),
}));

vi.mock("@/store/reviewDrafts", () => ({
  useReviewDrafts: (selector: (s: unknown) => unknown) => selector({ clear: vi.fn() }),
  useDraftsFor: () => [],
}));

// Monaco can't mount under jsdom.
vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

import { ReviewPopover } from "./GitHubReview";

function openPopover(author?: string) {
  render(<ReviewPopover repoId={1} number={7} author={author} />);
  fireEvent.click(screen.getByRole("button", { name: /submit review/i }));
}

const NOTE = /you can't approve or request changes/i;

describe("ReviewPopover own-PR guard", () => {
  beforeEach(() => {
    submitMutate.mockClear();
    authState.data = { logged_in: true, login: "octocat" };
  });

  it("keeps every option enabled when the viewer is not the author", () => {
    openPopover("someone-else");
    expect(screen.getByRole("radio", { name: /approve/i })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /request changes/i })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /^comment/i })).toBeEnabled();
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it("disables approve and request-changes on the viewer's own PR", () => {
    openPopover("octocat");
    expect(screen.getByRole("radio", { name: /approve/i })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /request changes/i })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /^comment/i })).toBeEnabled();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it("keeps every option enabled when the author is unknown", () => {
    openPopover(undefined);
    expect(screen.getByRole("radio", { name: /approve/i })).toBeEnabled();
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it("submits COMMENT even if APPROVE was picked before the author resolved", () => {
    // The author prop can arrive after the popover is open (list still
    // loading); an APPROVE picked in that window must be clamped on submit.
    const { rerender } = render(<ReviewPopover repoId={1} number={7} author={undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /submit review/i }));
    fireEvent.click(screen.getByRole("radio", { name: /approve/i }));

    rerender(<ReviewPopover repoId={1} number={7} author="octocat" />);
    expect(screen.getByRole("radio", { name: /^comment/i })).toBeChecked();

    // COMMENT needs a body; the clamped submit stays blocked until one exists,
    // so the disabled state is the observable guard here.
    const submitButtons = screen.getAllByRole("button", { name: /submit review/i });
    expect(submitButtons[submitButtons.length - 1]).toBeDisabled();
  });
});
