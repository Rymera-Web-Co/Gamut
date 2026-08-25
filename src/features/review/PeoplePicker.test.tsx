import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The collaborator list comes through the ipc bridge; feed it fixed data so the
// picker renders without a Tauri backend (#334).
const collaborators = vi.hoisted(() => ({
  value: [] as { login: string; avatar: string | null }[],
  /** Resolve the fetch by hand, to observe the loading branch. */
  gate: null as null | (() => void),
}));
const githubCollaborators = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ipc", () => ({ ipc: { githubCollaborators } }));

import { PeoplePicker } from "./PeoplePicker";

const PEOPLE = [
  { login: "alice", avatar: null },
  { login: "bob", avatar: null },
  { login: "carol", avatar: null },
];

function renderPicker(props: Partial<Parameters<typeof PeoplePicker>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onToggle = props.onToggle ?? vi.fn();
  const view = render(
    <QueryClientProvider client={qc}>
      <PeoplePicker
        repoId={1}
        label="Edit reviewers"
        isChecked={() => false}
        {...props}
        onToggle={onToggle}
      />
    </QueryClientProvider>,
  );
  return { ...view, onToggle };
}

const openPicker = () => fireEvent.click(screen.getByRole("button", { name: "Edit reviewers" }));
const popover = () => within(screen.getByRole("dialog"));
const rowFor = (login: string) =>
  popover().getByText(login).closest('[role="checkbox"]') as HTMLElement;

describe("PeoplePicker (#334)", () => {
  beforeEach(() => {
    collaborators.value = PEOPLE;
    collaborators.gate = null;
    githubCollaborators.mockReset();
    githubCollaborators.mockImplementation(() =>
      collaborators.gate
        ? new Promise((resolve) => {
            collaborators.gate = () => resolve(collaborators.value);
          })
        : Promise.resolve(collaborators.value),
    );
  });

  it("does not fetch collaborators until the popover opens", async () => {
    renderPicker();
    // Give any stray effect a tick to fire before asserting nothing happened.
    await Promise.resolve();
    expect(githubCollaborators).not.toHaveBeenCalled();

    openPicker();
    await waitFor(() => expect(githubCollaborators).toHaveBeenCalledWith(1));
  });

  it("shows a loading row while the list is in flight, then the people", async () => {
    collaborators.gate = () => {};
    renderPicker();
    openPicker();

    await waitFor(() => expect(popover().getByText(/loading/i)).toBeInTheDocument());
    expect(popover().queryByText(/no matching people/i)).toBeNull();
    expect(popover().queryByText(/no collaborators/i)).toBeNull();

    collaborators.gate?.();
    await waitFor(() => expect(popover().getByText("alice")).toBeInTheDocument());
    expect(popover().queryByText(/loading/i)).toBeNull();
  });

  it("distinguishes an empty repo list from a filter that matched nothing", async () => {
    collaborators.value = [];
    const { unmount } = renderPicker();
    openPicker();
    await waitFor(() => expect(popover().getByText(/no collaborators/i)).toBeInTheDocument());
    unmount();

    collaborators.value = PEOPLE;
    renderPicker();
    openPicker();
    await waitFor(() => expect(popover().getByText("alice")).toBeInTheDocument());
    fireEvent.change(popover().getByLabelText("Filter people"), { target: { value: "zzz" } });
    expect(popover().getByText(/no matching people/i)).toBeInTheDocument();
  });

  it("the filter input narrows the list to matching logins", async () => {
    renderPicker();
    openPicker();
    await waitFor(() => expect(popover().getByText("alice")).toBeInTheDocument());

    fireEvent.change(popover().getByLabelText("Filter people"), { target: { value: "o" } });
    expect(popover().getByText("bob")).toBeInTheDocument();
    expect(popover().getByText("carol")).toBeInTheDocument();
    expect(popover().queryByText("alice")).toBeNull();
  });

  it("stays open across a toggle, so several people can be picked in one go", async () => {
    const { onToggle } = renderPicker();
    openPicker();
    await waitFor(() => expect(popover().getByText("alice")).toBeInTheDocument());

    fireEvent.click(rowFor("alice"));
    expect(onToggle).toHaveBeenCalledWith("alice", true);
    // Unlike BaseBranchPicker, picking does not close the popover.
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(rowFor("bob"));
    expect(onToggle).toHaveBeenCalledWith("bob", true);
  });

  it("clears the filter when the popover closes", async () => {
    renderPicker();
    openPicker();
    await waitFor(() => expect(popover().getByText("alice")).toBeInTheDocument());
    fireEvent.change(popover().getByLabelText("Filter people"), { target: { value: "ali" } });
    expect(popover().getByLabelText("Filter people")).toHaveValue("ali");

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    openPicker();
    await waitFor(() => expect(popover().getByText("alice")).toBeInTheDocument());
    expect(popover().getByLabelText("Filter people")).toHaveValue("");
    expect(popover().getByText("bob")).toBeInTheDocument();
  });

  it("renders an ineligible person as a disabled row with the reason, and ignores clicks", async () => {
    const { onToggle } = renderPicker({
      rowDisabledReason: (login) => (login === "alice" ? "already reviewed" : null),
    });
    openPicker();
    await waitFor(() => expect(popover().getByText("alice")).toBeInTheDocument());

    expect(rowFor("alice")).toBeDisabled();
    expect(rowFor("alice")).toHaveTextContent("already reviewed");
    fireEvent.click(rowFor("alice"));
    expect(onToggle).not.toHaveBeenCalled();

    expect(rowFor("bob")).not.toBeDisabled();
    expect(rowFor("bob")).not.toHaveTextContent("already reviewed");
  });

  it("disables an in-flight row without showing a reason", async () => {
    renderPicker({ isRowDisabled: (login) => login === "alice" });
    openPicker();
    await waitFor(() => expect(popover().getByText("alice")).toBeInTheDocument());

    expect(rowFor("alice")).toBeDisabled();
    // No reason text, and the tooltip stays the plain login.
    expect(rowFor("alice")).toHaveAttribute("title", "alice");
    expect(rowFor("alice").querySelector(".text-xs")).toBeNull();
  });

  it("names the popover and its row group for assistive tech", async () => {
    renderPicker();
    openPicker();
    await waitFor(() => expect(popover().getByText("alice")).toBeInTheDocument());

    expect(screen.getByRole("dialog", { name: "Edit reviewers" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Edit reviewers" })).toBeInTheDocument();
  });
});
