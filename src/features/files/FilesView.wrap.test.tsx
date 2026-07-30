import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FilesView writes/reads files, reveals in the OS file manager, and mirrors IDE
// selection over ipc; there is no Tauri backend under jsdom, so stub the whole
// bridge (mirrors the DiffViewControls/WorkingTree test precedent).
vi.mock("@/lib/ipc", () => ({
  ipc: {
    getSettings: vi.fn(() => Promise.resolve({})),
    setSetting: vi.fn(() => Promise.resolve()),
    writeFile: vi.fn(() => Promise.resolve()),
    revealInFileManager: vi.fn(() => Promise.resolve()),
    resolvePath: vi.fn(() => Promise.resolve("/abs/path")),
    ideSelectionChanged: vi.fn(() => Promise.resolve()),
  },
}));

// One repo, id 1 — `is_git_repo` is flipped per-case (A1b) to prove the toggle
// isn't nested inside the Compare button's `is_git_repo !== false` gate.
const reposState = vi.hoisted(() => ({
  repos: [{ id: 1, name: "demo", path: "/tmp/demo", is_git_repo: true }],
}));
vi.mock("@/features/repos/api", () => ({
  useRepos: () => ({ data: reposState.repos }),
  useGroups: () => ({ data: [] }),
}));

// Per-path file content, set by each case (A0 fixture contract).
type ContentResult = {
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  data?: { text: string | null; too_large: boolean; is_binary: boolean; encoding_error: boolean };
};
const contentByPath = vi.hoisted(() => new Map<string, ContentResult>());
vi.mock("./api", () => ({
  useFileContent: (_repoId: number | null, path: string | null) =>
    (path && contentByPath.get(path)) ?? { isLoading: false, isError: false, data: undefined },
  useWorktreeStatus: () => ({
    isLoading: false,
    isError: false,
    data: { staged: [], unstaged: [] },
  }),
}));

// The tree/search panels pull in react-query hooks unrelated to the wrap
// toggle; stub them out (A0), same rationale as WorkingTree.test.tsx stubbing
// FileActionsMenu.
vi.mock("./RepoTree", () => ({ RepoTree: () => null }));
vi.mock("./SearchPanel", () => ({ SearchPanel: () => null }));
vi.mock("./ImageView", () => ({ ImageView: () => <div>image preview</div> }));

// Capture the *latest* render's Monaco options (overwrite-on-each-render, per
// WorkingTree.test.tsx:49-56) and count real mounts — the effect below fires
// once per actual mount (empty dep array), not on every re-render, so it proves
// the wrap toggle doesn't remount the editor (A4b).
const monaco = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  onMountCount: 0,
}));
vi.mock("@/components/MonacoEditor", () => ({
  CodeEditor: (props: { options: Record<string, unknown> }) => {
    monaco.options = props.options;
    useEffect(() => {
      monaco.onMountCount += 1;
    }, []);
    return null;
  },
}));

import { DEFAULTS, useSettings } from "@/lib/settings";
import { useUiStore } from "@/store/ui";
import { ipc } from "@/lib/ipc";
import { AppearancePanel } from "@/features/settings/panels/AppearancePanel";
import { DiffViewControls } from "@/features/review/DiffViewControls";
import { FilesView } from "./FilesView";

const TEXT_A = "src/a.ts";
const TEXT_B = "src/b.ts";
const IMAGE = "assets/logo.png";
const MD = "docs/readme.md";

function setContent(
  path: string,
  overrides: Partial<{
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    text: string | null;
    too_large: boolean;
    is_binary: boolean;
    encoding_error: boolean;
  }>,
) {
  const loadingOrError = Boolean(overrides.isLoading || overrides.isError);
  contentByPath.set(path, {
    isLoading: overrides.isLoading ?? false,
    isError: overrides.isError ?? false,
    error: overrides.error,
    data: loadingOrError
      ? undefined
      : {
          text: overrides.text ?? "line one\nline two\n",
          too_large: overrides.too_large ?? false,
          is_binary: overrides.is_binary ?? false,
          encoding_error: overrides.encoding_error ?? false,
        },
  });
}

function renderFiles() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <FilesView />
    </QueryClientProvider>,
  );
}

/** Seed the store to open `path` in repo 1 — the effect at
 * FilesView.tsx:190-199 adopts `filesPath` as the open file (A0). */
function openPath(path: string | null) {
  act(() => {
    useUiStore.setState({ filesPath: path });
  });
}

/** Locate a Settings `Field`'s control by its label text (A10). Walks up from
 * the label to the nearest ancestor that contains a switch — the `Field` root —
 * rather than assuming a fixed DOM depth, so a markup tweak in `controls.tsx`
 * doesn't silently break this. */
function fieldControl(labelText: string) {
  let node: HTMLElement | null = screen.getByText(labelText);
  while (node) {
    const control = node.querySelector('[role="switch"]');
    if (control) return control as HTMLElement;
    node = node.parentElement;
  }
  throw new Error(`No switch found for field "${labelText}"`);
}

describe("FilesView word wrap toggle (#295)", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettings.setState({ values: { ...DEFAULTS } });
    reposState.repos = [{ id: 1, name: "demo", path: "/tmp/demo", is_git_repo: true }];
    contentByPath.clear();
    monaco.options = null;
    monaco.onMountCount = 0;
    useUiStore.setState({
      activeRepoId: 1,
      activeGroupId: null,
      filesPath: null,
      filesPanel: "tree",
      compare: null,
    });
    setContent(TEXT_A, {});
    setContent(TEXT_B, { text: "second file\n" });
    setContent(MD, { text: "# Title\n" });
  });

  afterEach(() => {
    useUiStore.setState({ activeRepoId: null, filesPath: null });
  });

  it("is present with a text file open, before Compare in DOM order (A1/A1c)", () => {
    renderFiles();
    openPath(TEXT_A);
    const wrap = screen.getByRole("button", { name: "Word wrap" });
    const compare = screen.getByRole("button", { name: "Compare" });
    expect(wrap).toBeInTheDocument();
    expect(wrap.compareDocumentPosition(compare) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is present even when Compare is absent for a non-git folder (A1b)", () => {
    reposState.repos = [{ id: 1, name: "demo", path: "/tmp/demo", is_git_repo: false }];
    renderFiles();
    openPath(TEXT_A);
    expect(screen.queryByRole("button", { name: "Compare" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Word wrap" })).toBeInTheDocument();
  });

  it("aria-pressed reflects the setting true on first render (A2)", () => {
    useSettings.setState({ values: { ...DEFAULTS, editorWordWrap: true } });
    renderFiles();
    openPath(TEXT_A);
    expect(screen.getByRole("button", { name: "Word wrap" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("aria-pressed reflects the setting false on first render (A2)", () => {
    renderFiles();
    openPath(TEXT_A);
    expect(screen.getByRole("button", { name: "Word wrap" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("a click is a real global settings write, not local component state (A3/A9b/A11)", () => {
    renderFiles();
    openPath(TEXT_A);
    const wrap = screen.getByRole("button", { name: "Word wrap" });

    expect(wrap.className).not.toContain("bg-[var(--color-secondary)]");
    expect(wrap.querySelector("svg")).toHaveClass("size-3.5");
    expect(wrap).toHaveAttribute("title", "Word wrap: off (applies to all editors)");

    fireEvent.click(wrap);

    expect(useSettings.getState().values.editorWordWrap).toBe(true);
    expect(ipc.setSetting).toHaveBeenCalledWith("pref.editorWordWrap", "1");
    const mirror = JSON.parse(localStorage.getItem("gamut.settings") ?? "{}") as Record<
      string,
      string
    >;
    expect(mirror.editorWordWrap).toBe("1");
    expect(wrap).toHaveAttribute("aria-pressed", "true");
    expect(wrap.className).toContain("bg-[var(--color-secondary)]");
    expect(wrap).toHaveAttribute("title", "Word wrap: on (applies to all editors)");
  });

  it("the flip reaches the mounted Monaco instance without remounting it (A4/A4b)", () => {
    renderFiles();
    openPath(TEXT_A);
    const wrap = screen.getByRole("button", { name: "Word wrap" });
    expect(monaco.options?.wordWrap).toBe("off");
    const mountsBefore = monaco.onMountCount;
    expect(mountsBefore).toBeGreaterThan(0);

    fireEvent.click(wrap);
    expect(monaco.options?.wordWrap).toBe("on");

    fireEvent.click(wrap);
    expect(monaco.options?.wordWrap).toBe("off");

    expect(monaco.onMountCount).toBe(mountsBefore);
    expect(monaco.options?.minimap).toEqual({ enabled: false });
    expect(monaco.options?.scrollBeyondLastLine).toBe(false);
  });

  it("is absent when a repo is selected but no file is open (A5)", () => {
    renderFiles();
    expect(screen.getByText("Select a file to open it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Word wrap" })).not.toBeInTheDocument();
  });

  it("is absent (and no header) when no repo is selected (A5b)", () => {
    useUiStore.setState({ activeRepoId: null });
    renderFiles();
    expect(
      screen.getByText("Select a repository from the left to browse its files."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Word wrap" })).not.toBeInTheDocument();
  });

  it("is absent for an image (A6)", () => {
    renderFiles();
    openPath(IMAGE);
    expect(screen.getByText("image preview")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Word wrap" })).not.toBeInTheDocument();
  });

  // Each absence case below also asserts the placeholder that branch renders.
  // Without that, a break in `openPath`'s contract with the store would leave
  // `selectedPath` null, render the "Select a file" empty state, and let every
  // one of these pass while testing nothing.
  it("is absent when the file is too_large (A7)", () => {
    const path = "src/big.ts";
    setContent(path, { text: null, too_large: true });
    renderFiles();
    openPath(path);
    expect(screen.getByText("File is too large to edit here (over 2 MB).")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Word wrap" })).not.toBeInTheDocument();
  });

  it("is absent when the file is_binary (A7)", () => {
    const path = "src/binfile.ts";
    setContent(path, { text: null, is_binary: true });
    renderFiles();
    openPath(path);
    expect(screen.getByText("Binary file — not shown.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Word wrap" })).not.toBeInTheDocument();
  });

  it("is absent when the file has an encoding_error (A7)", () => {
    const path = "src/badenc.ts";
    setContent(path, { text: null, encoding_error: true });
    renderFiles();
    openPath(path);
    expect(screen.getByText(/Not a UTF-8 text file/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Word wrap" })).not.toBeInTheDocument();
  });

  it("is absent while content is loading (A7b)", () => {
    const path = "src/loading.ts";
    setContent(path, { isLoading: true });
    const { container } = renderFiles();
    openPath(path);
    // The loading branch renders a spinning Loader2 and no text.
    expect(container.querySelector("svg.animate-spin")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Word wrap" })).not.toBeInTheDocument();
  });

  it("is absent when content errors (A7b)", () => {
    const path = "src/erroring.ts";
    setContent(path, { isError: true, error: new Error("boom") });
    renderFiles();
    openPath(path);
    expect(screen.getByText(/boom/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Word wrap" })).not.toBeInTheDocument();
  });

  it("md + preview-by-default off: present in Edit, absent in Preview (A8)", () => {
    useSettings.setState({ values: { ...DEFAULTS, markdownPreviewByDefault: false } });
    renderFiles();
    openPath(MD);
    expect(screen.getByRole("button", { name: "Word wrap" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.queryByRole("button", { name: "Word wrap" })).not.toBeInTheDocument();
  });

  it("md + preview-by-default on: absent on open, present after clicking Edit (A8b)", () => {
    useSettings.setState({ values: { ...DEFAULTS, markdownPreviewByDefault: true } });
    renderFiles();
    openPath(MD);
    expect(screen.queryByRole("button", { name: "Word wrap" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Word wrap" })).toBeInTheDocument();
  });

  it("stays in lock-step with the Review tab and Settings → Appearance (A10)", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <div data-testid="files">
          <FilesView />
        </div>
        <div data-testid="review">
          <DiffViewControls />
        </div>
        <AppearancePanel />
      </QueryClientProvider>,
    );
    openPath(TEXT_A);

    const filesWrap = () =>
      within(screen.getByTestId("files")).getByRole("button", { name: "Word wrap" });
    const reviewWrap = () =>
      within(screen.getByTestId("review")).getByRole("button", { name: "Word wrap" });
    const apprWrap = () => fieldControl("Editor word wrap");

    expect(filesWrap()).toHaveAttribute("aria-pressed", "false");
    expect(reviewWrap()).toHaveAttribute("aria-pressed", "false");
    expect(apprWrap()).toHaveAttribute("aria-checked", "false");

    fireEvent.click(filesWrap());
    expect(filesWrap()).toHaveAttribute("aria-pressed", "true");
    expect(reviewWrap()).toHaveAttribute("aria-pressed", "true");
    expect(apprWrap()).toHaveAttribute("aria-checked", "true");

    fireEvent.click(reviewWrap());
    expect(filesWrap()).toHaveAttribute("aria-pressed", "false");
    expect(reviewWrap()).toHaveAttribute("aria-pressed", "false");
    expect(apprWrap()).toHaveAttribute("aria-checked", "false");

    fireEvent.click(apprWrap());
    expect(filesWrap()).toHaveAttribute("aria-pressed", "true");
    expect(reviewWrap()).toHaveAttribute("aria-pressed", "true");
    expect(apprWrap()).toHaveAttribute("aria-checked", "true");
  });

  // Scoped to wrap-related keys on purpose: a full `DEFAULTS` key inventory
  // would fail on any unrelated future setting, under a test name that would
  // misdirect whoever had to debug it.
  it("adds no new wrap setting and keeps the wrap default off (A12)", () => {
    expect(DEFAULTS.editorWordWrap).toBe(false);
    expect(Object.keys(DEFAULTS).filter((k) => /wrap/i.test(k))).toEqual(["editorWordWrap"]);
  });

  it("has no per-file/per-tab wrap state — the global value survives switching files (A13)", () => {
    renderFiles();
    openPath(TEXT_A);
    const wrap = () => screen.getByRole("button", { name: "Word wrap" });

    fireEvent.click(wrap());
    expect(monaco.options?.wordWrap).toBe("on");

    openPath(TEXT_B);
    expect(monaco.options?.wordWrap).toBe("on");

    fireEvent.click(wrap());
    expect(monaco.options?.wordWrap).toBe("off");

    openPath(TEXT_A);
    expect(monaco.options?.wordWrap).toBe("off");
  });
});
