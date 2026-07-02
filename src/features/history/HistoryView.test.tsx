import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import type { CommitDetail } from "@/lib/ipc";
import { formatDate } from "@/lib/format";

// Mock the data hooks so the panel renders synchronously with fixed data.
const detail = vi.hoisted(() => ({ value: null as CommitDetail | null }));
const avatar = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("./api", () => ({
  useCommitDetail: () => ({ data: detail.value }),
  useCommitAvatar: () => ({ data: avatar.value }),
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
  beforeEach(() => {
    detail.value = COMMIT;
    avatar.value = null;
  });

  it("renders an avatar next to the author name for the selected commit", () => {
    render(<CommitDetailPanel repoId={1} sha={COMMIT.sha} />);
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("falls back to the author's initials when no avatar image is available", () => {
    detail.value = COMMIT;
    avatar.value = null;
    render(<CommitDetailPanel repoId={1} sha={COMMIT.sha} />);
    // The Avatar fallback is a titled element showing the leading initial.
    const el = screen.getByTitle("Ada Lovelace");
    expect(el.tagName).toBe("SPAN");
    expect(el).toHaveTextContent("A");
  });

  it("renders the resolved GitHub avatar image when one is available", () => {
    detail.value = COMMIT;
    avatar.value = "https://avatars.githubusercontent.com/u/1?v=4";
    render(<CommitDetailPanel repoId={1} sha={COMMIT.sha} />);
    const img = screen.getByTitle("Ada Lovelace");
    expect(img.tagName).toBe("IMG");
    expect(img).toHaveAttribute("src", avatar.value);
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
