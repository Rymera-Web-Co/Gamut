import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { CommitDetail } from "@/lib/ipc";
import { formatDate } from "@/lib/format";

// Mock the data hook so the panel renders synchronously with fixed detail data.
const detail = vi.hoisted(() => ({ value: null as CommitDetail | null }));
vi.mock("./api", () => ({
  useCommitDetail: () => ({ data: detail.value }),
}));
// DiffModal pulls in the Monaco editor, which vitest can't resolve and which
// this panel never renders in the test (no file is opened). Stub it out.
vi.mock("./DiffModal", () => ({ DiffModal: () => null }));

import { CommitDetailPanel } from "./HistoryView";

const COMMIT: CommitDetail = {
  sha: "0123456789abcdef0123456789abcdef01234567",
  author_name: "Ada Lovelace",
  author_email: "ada@example.com",
  timestamp: 1_700_000_000,
  message: "Add the analytical engine",
  files: [],
};

describe("CommitDetailPanel author tag", () => {
  it("renders an avatar next to the author name for the selected commit", () => {
    detail.value = COMMIT;
    render(<CommitDetailPanel repoId={1} sha={COMMIT.sha} />);
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("falls back to the author's initials when no avatar image is available", () => {
    detail.value = COMMIT;
    render(<CommitDetailPanel repoId={1} sha={COMMIT.sha} />);
    // The Avatar fallback is a titled element showing the leading initial.
    const avatar = screen.getByTitle("Ada Lovelace");
    expect(avatar.tagName).toBe("SPAN");
    expect(avatar).toHaveTextContent("A");
  });

  it("keeps showing the existing author email, timestamp, and commit hash", () => {
    detail.value = COMMIT;
    render(<CommitDetailPanel repoId={1} sha={COMMIT.sha} />);
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === "SPAN" &&
          el.textContent?.trim() === `<${COMMIT.author_email}> · ${formatDate(COMMIT.timestamp)}`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(COMMIT.sha)).toBeInTheDocument();
  });
});
