import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FilesView writes/reads files, reveals in the OS file manager, and mirrors IDE
// selection over ipc; there is no Tauri backend under jsdom, so stub the whole
// bridge (mirrors the FilesView.wrap.test.tsx precedent).
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

// The external-link bridge (A21/A23) must end up here — the same opener every
// other external link in the app uses — and nowhere else.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

const reposState = vi.hoisted(() => ({
  repos: [{ id: 1, name: "demo", path: "/tmp/demo", is_git_repo: true }],
}));
vi.mock("@/features/repos/api", () => ({
  useRepos: () => ({ data: reposState.repos }),
  useGroups: () => ({ data: [] }),
}));

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

vi.mock("./RepoTree", () => ({ RepoTree: () => null }));
vi.mock("./SearchPanel", () => ({ SearchPanel: () => null }));
vi.mock("./ImageView", () => ({ ImageView: () => <div>image preview</div> }));

// Stand-in for Monaco: records the latest render's `language` and the buffer's
// onChange (so a test can type without a real editor), and renders a marker so
// "is Monaco mounted?" is directly observable for the A25 invariant.
const monaco = vi.hoisted(() => ({
  language: null as string | null,
  onChange: null as ((v: string | undefined) => void) | null,
  mountCount: 0,
}));
vi.mock("@/components/MonacoEditor", () => ({
  CodeEditor: (props: { language: string; onChange: (v: string | undefined) => void }) => {
    monaco.language = props.language;
    monaco.onChange = props.onChange;
    useEffect(() => {
      monaco.mountCount += 1;
    }, []);
    return <div data-testid="monaco-editor" />;
  },
}));

import { openUrl } from "@tauri-apps/plugin-opener";
import { DEFAULTS, useSettings } from "@/lib/settings";
import { useUiStore } from "@/store/ui";
import { useToasts } from "@/store/toast";
import { ipc } from "@/lib/ipc";
import { AppearancePanel } from "@/features/settings/panels/AppearancePanel";
import { FilesView } from "./FilesView";
import { HtmlPreview } from "./HtmlPreview";
import { MSG_HTML, MSG_OPEN_EXTERNAL, MSG_READY, previewUrl } from "./previewProtocol";

const HTML = "site/index.html";
const HTML_B = "site/other.html";
const HTM = "site/legacy.htm";
const HTM_UPPER = "site/LEGACY.HTM";
const HTML_UPPER = "site/INDEX.HTML";
const VUE = "src/App.vue";
const MD = "docs/readme.md";
const TEXT = "src/a.ts";
const IMAGE = "assets/logo.png";

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
          // `?? default` would swallow an explicit `text: null`, and a null text
          // is exactly what makes a file non-editable — the case several of the
          // assertions below turn on.
          text: "text" in overrides ? (overrides.text ?? null) : "<p>hello</p>\n",
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

/** Seed the store to open `path` in repo 1 (the `filesPath` deep-link effect). */
function openPath(path: string | null) {
  act(() => {
    useUiStore.setState({ filesPath: path });
  });
}

// --- Preview-frame harness ---------------------------------------------------
// jsdom never navigates the `gamut-preview://` scheme, so a real iframe here has
// no usable `contentWindow`. Substitute a per-element stand-in: it gives the
// component something to post to, and doubles as the `event.source` identity the
// parent validates against (A21).

type FakeWindow = { postMessage: ReturnType<typeof vi.fn> };
const frameWindows = new WeakMap<HTMLIFrameElement, FakeWindow>();
let realContentWindow: PropertyDescriptor | undefined;

function installFrameHarness() {
  realContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    get(this: HTMLIFrameElement) {
      let w = frameWindows.get(this);
      if (!w) {
        w = { postMessage: vi.fn() };
        frameWindows.set(this, w);
      }
      return w;
    },
  });
}

function restoreFrameHarness() {
  if (realContentWindow) {
    Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", realContentWindow);
  }
}

function frameEl(): HTMLIFrameElement {
  const el = document.querySelector("iframe");
  if (!el) throw new Error("no preview iframe is rendered");
  return el;
}

function frameWindow(): FakeWindow {
  return frameEl().contentWindow as unknown as FakeWindow;
}

/** Dispatch a `message` event as if it came from `source`. `MessageEvent`'s IDL
 * only accepts real windows for `source`, so shadow the accessor instead. */
function postAsIfFrom(source: unknown, data: unknown) {
  const event = new MessageEvent("message", { data });
  Object.defineProperty(event, "source", { value: source });
  act(() => {
    window.dispatchEvent(event);
  });
}

/** Complete the bootstrap handshake for the currently-mounted frame. */
function sendReady(token = "tok-1"): { window: FakeWindow; token: string } {
  const w = frameWindow();
  postAsIfFrom(w, { type: MSG_READY, token });
  return { window: w, token };
}

/** The HTML payloads the parent has delivered to `w`, oldest first. */
function delivered(w: FakeWindow): string[] {
  return w.postMessage.mock.calls
    .map(([msg]) => msg as { type?: string; html?: string })
    .filter((msg) => msg?.type === MSG_HTML)
    .map((msg) => String(msg.html));
}

beforeEach(() => {
  localStorage.clear();
  useSettings.setState({ values: { ...DEFAULTS } });
  reposState.repos = [{ id: 1, name: "demo", path: "/tmp/demo", is_git_repo: true }];
  contentByPath.clear();
  monaco.language = null;
  monaco.onChange = null;
  monaco.mountCount = 0;
  vi.mocked(openUrl).mockClear();
  vi.mocked(ipc.setSetting).mockClear();
  useUiStore.setState({
    activeRepoId: 1,
    activeGroupId: null,
    filesPath: null,
    filesPanel: "tree",
    compare: null,
  });
  for (const path of [HTML, HTML_B, HTM, HTM_UPPER, HTML_UPPER, VUE, MD, TEXT]) {
    setContent(path, {});
  }
  setContent(HTML_B, { text: "<p>other file</p>\n" });
  setContent(MD, { text: "# Title\n" });
  setContent(TEXT, { text: "const a = 1;\n" });
  installFrameHarness();
});

afterEach(() => {
  restoreFrameHarness();
  useUiStore.setState({ activeRepoId: null, filesPath: null });
});

const toggle = () => screen.queryByRole("button", { name: "Preview" });
const wrapToggle = () => screen.queryByRole("button", { name: "Word wrap" });
const editor = () => screen.queryByTestId("monaco-editor");
const iframeOrNull = () => document.querySelector("iframe");

describe("FilesView HTML edit/preview gate (#296)", () => {
  it("shows the Edit/Preview control for an .html file (A1)", () => {
    renderFiles();
    openPath(HTML);
    expect(toggle()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("shows it for .htm and for uppercase basenames (A2)", () => {
    for (const path of [HTM, HTM_UPPER, HTML_UPPER]) {
      const { unmount } = renderFiles();
      openPath(path);
      expect(toggle()).toBeInTheDocument();
      unmount();
      openPath(null);
    }
  });

  it("shows no toggle for a .vue file and keeps the plain editor (A3)", () => {
    renderFiles();
    openPath(VUE);
    expect(toggle()).not.toBeInTheDocument();
    expect(editor()).toBeInTheDocument();
    // Still highlighted as html — that mismatch is why the gate is `isHtmlPath`.
    expect(monaco.language).toBe("html");
    expect(iframeOrNull()).toBeNull();
  });

  it("edits .html and .htm in Monaco with language=html (A6)", () => {
    renderFiles();
    openPath(HTML);
    expect(editor()).toBeInTheDocument();
    expect(monaco.language).toBe("html");

    openPath(HTM);
    expect(editor()).toBeInTheDocument();
    expect(monaco.language).toBe("html");
  });

  it("shows no toggle and no frame for a non-editable HTML file (A26)", () => {
    const cases: Array<[string, Partial<Parameters<typeof setContent>[1]>, RegExp]> = [
      ["site/big.html", { text: null, too_large: true }, /too large to edit/],
      ["site/bin.html", { text: null, is_binary: true }, /Binary file/],
      ["site/enc.html", { text: null, encoding_error: true }, /Not a UTF-8 text file/],
    ];
    for (const [path, overrides, message] of cases) {
      setContent(path, overrides);
      const { unmount } = renderFiles();
      openPath(path);
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(toggle()).not.toBeInTheDocument();
      expect(iframeOrNull()).toBeNull();
      unmount();
      openPath(null);
    }
  });

  it("shows no toggle and no frame while an HTML file loads or errors (A26)", () => {
    setContent("site/loading.html", { isLoading: true });
    const first = renderFiles();
    openPath("site/loading.html");
    expect(toggle()).not.toBeInTheDocument();
    expect(iframeOrNull()).toBeNull();
    first.unmount();
    openPath(null);

    setContent("site/broken.html", { isError: true, error: new Error("read failed") });
    renderFiles();
    openPath("site/broken.html");
    expect(screen.getByText("Error: read failed")).toBeInTheDocument();
    expect(toggle()).not.toBeInTheDocument();
    expect(iframeOrNull()).toBeNull();
  });
});

describe("FilesView HTML preview pane (#296)", () => {
  it("renders the sandboxed frame instead of Monaco when Preview is picked (A7/A25)", () => {
    renderFiles();
    openPath(HTML);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(editor()).not.toBeInTheDocument();
    const el = frameEl();
    expect(el.getAttribute("src")).toBe(previewUrl());
    expect(el.hasAttribute("srcdoc")).toBe(false);
  });

  it("delivers the current unsaved buffer, not the file on disk (A13/A14)", () => {
    renderFiles();
    openPath(HTML);
    act(() => monaco.onChange?.("<p>unsaved edit</p>"));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    // A14: nothing is posted before the frame says it is listening.
    const w = frameWindow();
    expect(w.postMessage).not.toHaveBeenCalled();

    sendReady();
    expect(delivered(w)).toEqual(["<p>unsaved edit</p>"]);
    // The buffer is still dirty — the preview did not save anything.
    expect(ipc.writeFile).not.toHaveBeenCalled();
  });

  it("never shows the previous file's bytes after switching files (A26)", () => {
    useSettings.setState({ values: { ...DEFAULTS, htmlPreviewByDefault: true } });
    renderFiles();
    openPath(HTML);
    const first = sendReady("tok-a");
    expect(delivered(first.window)).toEqual(["<p>hello</p>\n"]);

    openPath(HTML_B);
    // A fresh frame, so nothing of the previous render survives.
    const second = frameWindow();
    expect(second).not.toBe(first.window);
    sendReady("tok-b");
    expect(delivered(second)).toEqual(["<p>other file</p>\n"]);
    expect(delivered(second)).not.toContain("<p>hello</p>\n");
  });

  it("drops the frame when the open file stops being HTML, and on a repo switch (A26)", () => {
    useSettings.setState({ values: { ...DEFAULTS, htmlPreviewByDefault: true } });
    renderFiles();
    openPath(HTML);
    expect(iframeOrNull()).not.toBeNull();

    openPath(TEXT);
    expect(iframeOrNull()).toBeNull();
    expect(editor()).toBeInTheDocument();

    openPath(HTML);
    expect(iframeOrNull()).not.toBeNull();
    act(() => {
      useUiStore.setState({ activeRepoId: 2 });
    });
    expect(iframeOrNull()).toBeNull();
  });
});

// The `useFileContent` mock above resolves synchronously, which collapses "the
// content arrived" and "the buffer arrived" into a single batch and hides two
// render-ordering bugs the real app has. Both are driven here explicitly.
describe("FilesView HTML preview across a real two-phase update (#296)", () => {
  /** Re-render FilesView without touching the open file. */
  function rerenderFiles() {
    act(() => {
      useUiStore.setState({ activeGroupId: (useUiStore.getState().activeGroupId ?? 0) + 1 });
    });
  }

  it("does not remount the frame when the buffer lands a render after the content", () => {
    vi.useFakeTimers();
    try {
      useSettings.setState({ values: { ...DEFAULTS, htmlPreviewByDefault: true } });
      // Still loading when the file is opened, so when the content resolves the
      // preview branch is reached with `value` still empty — the real app's
      // ordering, where the frame mounts first and is handed the text only on the
      // handshake.
      setContent(HTML, { isLoading: true });
      renderFiles();
      openPath(HTML);
      expect(iframeOrNull()).toBeNull();

      setContent(HTML, { text: "<p>hello</p>\n" });
      rerenderFiles();

      const first = frameEl();
      const w = frameWindow();
      postAsIfFrom(w, { type: MSG_READY, token: "t1" });
      expect(delivered(w)).toEqual(["<p>hello</p>\n"]);

      // Well past the debounce. The frame that already rendered the right text
      // must survive: remounting it re-runs the previewed page's scripts,
      // animations and network calls, with a visible blank-and-re-render.
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(frameEl()).toBe(first);
      expect(delivered(w)).toEqual(["<p>hello</p>\n"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never creates a frame when switching from a previewed markdown file to HTML", () => {
    useSettings.setState({
      values: { ...DEFAULTS, markdownPreviewByDefault: true, htmlPreviewByDefault: false },
    });
    const createElement = vi.spyOn(document, "createElement");
    const framesCreated = () =>
      createElement.mock.calls.filter(([tag]) => String(tag).toLowerCase() === "iframe").length;
    try {
      renderFiles();
      openPath(MD);
      expect(editor()).not.toBeInTheDocument(); // markdown opened in preview
      expect(framesCreated()).toBe(0);

      openPath(HTML);
      // Not even for the single commit between the switch and the reset: a frame
      // there would fire a request at the CSP-free preview origin and be seeded
      // with the *markdown* file's buffer, for a file whose default is Edit.
      expect(framesCreated()).toBe(0);
      expect(iframeOrNull()).toBeNull();
      expect(editor()).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Edit" })).toHaveAttribute("aria-pressed", "true");
    } finally {
      createElement.mockRestore();
    }
  });
});

// A25: the word-wrap toggle (#295) exists to control a mounted Monaco, so the
// two must agree on every branch of the right pane's render chain. This is the
// invariant documented at FilesView.tsx's `editorShown`, and the clause most
// likely to be missed when a new preview branch is added.
describe("FilesView editorShown mirrors the render chain (#296 A25)", () => {
  const branches: Array<[string, () => void, boolean]> = [
    ["no repo selected", () => useUiStore.setState({ activeRepoId: null }), false],
    ["no file open", () => {}, false],
    ["an image", () => openPath(IMAGE), false],
    [
      "content loading",
      () => {
        setContent("site/l.html", { isLoading: true });
        openPath("site/l.html");
      },
      false,
    ],
    [
      "content errored",
      () => {
        setContent("site/e.html", { isError: true, error: new Error("nope") });
        openPath("site/e.html");
      },
      false,
    ],
    [
      "too_large",
      () => {
        setContent("site/big.html", { text: null, too_large: true });
        openPath("site/big.html");
      },
      false,
    ],
    [
      "is_binary",
      () => {
        setContent("site/bin.html", { text: null, is_binary: true });
        openPath("site/bin.html");
      },
      false,
    ],
    [
      "encoding_error",
      () => {
        setContent("site/enc.html", { text: null, encoding_error: true });
        openPath("site/enc.html");
      },
      false,
    ],
    ["a plain text file", () => openPath(TEXT), true],
    ["markdown in edit mode", () => openPath(MD), true],
    [
      "markdown in preview mode",
      () => {
        openPath(MD);
        fireEvent.click(screen.getByRole("button", { name: "Preview" }));
      },
      false,
    ],
    ["html in edit mode", () => openPath(HTML), true],
    [
      "html in preview mode",
      () => {
        openPath(HTML);
        fireEvent.click(screen.getByRole("button", { name: "Preview" }));
      },
      false,
    ],
  ];

  for (const [name, setup, monacoExpected] of branches) {
    it(`agrees for: ${name}`, () => {
      renderFiles();
      // Applied after mount: `openPath` drives the one-shot `filesPath` effect,
      // and the toggle clicks need the header on screen.
      setup();
      const hasEditor = editor() != null;
      const hasWrap = wrapToggle() != null;
      expect(hasEditor).toBe(monacoExpected);
      expect(hasWrap).toBe(hasEditor);
    });
  }
});

describe("htmlPreviewByDefault setting (#296 A24)", () => {
  it("defaults to off and is a distinct key from the markdown one", () => {
    expect(DEFAULTS.htmlPreviewByDefault).toBe(false);
    expect(DEFAULTS.markdownPreviewByDefault).toBe(false);
    expect(
      Object.keys(DEFAULTS)
        .filter((k) => /PreviewByDefault$/.test(k))
        .sort(),
    ).toEqual(["htmlPreviewByDefault", "markdownPreviewByDefault"]);
  });

  it("off → an HTML file opens in Edit", () => {
    renderFiles();
    openPath(HTML);
    expect(editor()).toBeInTheDocument();
    expect(iframeOrNull()).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toHaveAttribute("aria-pressed", "true");
  });

  it("on → an HTML file opens in Preview", () => {
    useSettings.setState({ values: { ...DEFAULTS, htmlPreviewByDefault: true } });
    renderFiles();
    openPath(HTML);
    expect(iframeOrNull()).not.toBeNull();
    expect(editor()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");
  });

  it("is independent of markdownPreviewByDefault, both ways round", () => {
    useSettings.setState({
      values: { ...DEFAULTS, htmlPreviewByDefault: true, markdownPreviewByDefault: false },
    });
    const first = renderFiles();
    openPath(HTML);
    expect(iframeOrNull()).not.toBeNull();
    openPath(MD);
    expect(editor()).toBeInTheDocument();
    first.unmount();
    openPath(null);

    useSettings.setState({
      values: { ...DEFAULTS, htmlPreviewByDefault: false, markdownPreviewByDefault: true },
    });
    renderFiles();
    openPath(MD);
    expect(editor()).not.toBeInTheDocument();
    openPath(HTML);
    expect(editor()).toBeInTheDocument();
    expect(iframeOrNull()).toBeNull();
  });

  it("persists through the Appearance toggle and a reload from the DB", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AppearancePanel />
      </QueryClientProvider>,
    );

    let node: HTMLElement | null = screen.getByText("Open HTML in preview");
    let control: HTMLElement | null = null;
    while (node && !control) {
      control = node.querySelector('[role="switch"]');
      node = node.parentElement;
    }
    if (!control) throw new Error("no switch for the HTML preview setting");

    expect(control).toHaveAttribute("aria-checked", "false");
    fireEvent.click(control);
    expect(control).toHaveAttribute("aria-checked", "true");
    expect(useSettings.getState().values.htmlPreviewByDefault).toBe(true);
    expect(ipc.setSetting).toHaveBeenCalledWith("pref.htmlPreviewByDefault", "1");

    // A rehydrated store honours the stored value.
    useSettings.setState({ values: { ...DEFAULTS } });
    vi.mocked(ipc.getSettings).mockResolvedValueOnce({ "pref.htmlPreviewByDefault": "1" });
    await act(async () => {
      await useSettings.getState().load();
    });
    expect(useSettings.getState().values.htmlPreviewByDefault).toBe(true);
  });
});

// The frame itself, driven directly — the isolation attributes, the delivery
// lifecycle and the two validated message bridges.
describe("HtmlPreview frame (#296)", () => {
  // Mirror HtmlPreview's own timings; they aren't exported (nothing else needs
  // them), so keep these in step with the constants at the top of that file.
  const OPEN_INTERVAL_MS = 2000;
  const READY_TIMEOUT_MS = 4000;

  beforeEach(() => {
    vi.useFakeTimers();
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function renderFrame(html = "<p>one</p>") {
    return render(<HtmlPreview html={html} />);
  }

  function tick(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  it("sandboxes with exactly {allow-scripts} (A7)", () => {
    renderFrame();
    const tokens = new Set((frameEl().getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean));
    expect(tokens).toEqual(new Set(["allow-scripts"]));
  });

  it("grants no escape token — same-origin, forms, top-navigation, popups (A8)", () => {
    renderFrame();
    const sandbox = frameEl().getAttribute("sandbox") ?? "";
    const tokens = new Set(sandbox.split(/\s+/).filter(Boolean));
    for (const forbidden of [
      "allow-same-origin",
      "allow-forms",
      "allow-top-navigation",
      "allow-top-navigation-by-user-activation",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-modals",
      "allow-pointer-lock",
      "allow-presentation",
      "allow-downloads",
    ]) {
      expect(tokens.has(forbidden)).toBe(false);
    }
  });

  it("loads the preview scheme and never uses srcdoc (A9/A10)", () => {
    renderFrame();
    expect(frameEl().getAttribute("src")).toBe(previewUrl());
    expect(frameEl().hasAttribute("srcdoc")).toBe(false);
    expect(frameEl().getAttribute("srcdoc")).toBeNull();
  });

  it("paints a themed background so there is no white flash pre-handshake (A26)", () => {
    const { container } = renderFrame();
    const themed = "bg-[var(--color-background)]";
    expect(frameEl().className).toContain(themed);
    expect((container.firstElementChild as HTMLElement).className).toContain(themed);
  });

  it("posts the buffer only in response to the ready handshake (A14)", () => {
    renderFrame("<p>one</p>");
    const w = frameWindow();
    expect(w.postMessage).not.toHaveBeenCalled();
    tick(1000);
    expect(w.postMessage).not.toHaveBeenCalled();

    postAsIfFrom(w, { type: MSG_READY, token: "t1" });
    expect(delivered(w)).toEqual(["<p>one</p>"]);
    expect(w.postMessage.mock.calls[0][0]).toMatchObject({ type: MSG_HTML, token: "t1" });
    // Sandboxed frames have an opaque origin, so the parent must post to "*".
    expect(w.postMessage.mock.calls[0][1]).toBe("*");
  });

  it("remounts and re-delivers on every subsequent buffer change, not just the first (A15)", () => {
    const { rerender } = renderFrame("<p>one</p>");
    const first = frameWindow();
    postAsIfFrom(first, { type: MSG_READY, token: "t1" });
    expect(delivered(first)).toEqual(["<p>one</p>"]);

    for (const [n, html] of [
      ["t2", "<p>two</p>"],
      ["t3", "<p>three</p>"],
    ] as const) {
      rerender(<HtmlPreview html={html} />);
      tick(500);
      const w = frameWindow();
      postAsIfFrom(w, { type: MSG_READY, token: n });
      expect(delivered(w)).toEqual([html]);
    }
  });

  it("coalesces a burst of buffer changes and delivers the last one (A16)", () => {
    const { rerender } = renderFrame("a");
    const first = frameWindow();
    postAsIfFrom(first, { type: MSG_READY, token: "t1" });

    rerender(<HtmlPreview html="ab" />);
    tick(100);
    rerender(<HtmlPreview html="abc" />);
    tick(100);
    rerender(<HtmlPreview html="abcd" />);
    // Still inside the debounce window: no new frame yet.
    expect(frameWindow()).toBe(first);
    tick(500);

    const w = frameWindow();
    expect(w).not.toBe(first);
    postAsIfFrom(w, { type: MSG_READY, token: "t2" });
    expect(delivered(w)).toEqual(["abcd"]);
  });

  it("posts nothing after unmount, mid-debounce (A17)", () => {
    const { rerender, unmount } = renderFrame("<p>one</p>");
    const w = frameWindow();
    postAsIfFrom(w, { type: MSG_READY, token: "t1" });
    w.postMessage.mockClear();

    rerender(<HtmlPreview html="<p>two</p>" />);
    unmount();
    tick(2000);
    postAsIfFrom(w, { type: MSG_READY, token: "t2" });
    postAsIfFrom(w, { type: MSG_OPEN_EXTERNAL, token: "t1", url: "https://example.com/" });

    expect(w.postMessage).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("opens an http(s) link through the app's opener, exactly once (A23)", () => {
    renderFrame();
    const w = frameWindow();
    postAsIfFrom(w, { type: MSG_READY, token: "t1" });

    postAsIfFrom(w, { type: MSG_OPEN_EXTERNAL, token: "t1", url: "https://example.com/docs" });
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");

    // Past the bridge's rate limit (see the test below), so this asserts a second
    // genuine click still opens rather than the throttle.
    tick(OPEN_INTERVAL_MS + 1);
    postAsIfFrom(w, { type: MSG_OPEN_EXTERNAL, token: "t1", url: "http://example.org/" });
    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(openUrl).toHaveBeenLastCalledWith("http://example.org/");
    // The frame is never navigated by the parent.
    expect(frameEl().getAttribute("src")).toBe(previewUrl());
  });

  // With `allow-scripts` a previewed page can cover its whole viewport with one
  // `<a href>`, so any genuine click opens a URL the user never saw. The limit is
  // parent-side on purpose: nothing the frame posts can reset or shorten it.
  it("rate-limits the external-link bridge to one open per interval (#296)", () => {
    renderFrame();
    const w = frameWindow();
    postAsIfFrom(w, { type: MSG_READY, token: "t1" });

    postAsIfFrom(w, { type: MSG_OPEN_EXTERNAL, token: "t1", url: "https://example.com/a" });
    expect(openUrl).toHaveBeenCalledTimes(1);

    // Immediately after, and just short of the interval: both ignored.
    postAsIfFrom(w, { type: MSG_OPEN_EXTERNAL, token: "t1", url: "https://example.com/b" });
    tick(OPEN_INTERVAL_MS - 1);
    postAsIfFrom(w, { type: MSG_OPEN_EXTERNAL, token: "t1", url: "https://example.com/c" });
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenLastCalledWith("https://example.com/a");

    tick(2);
    postAsIfFrom(w, { type: MSG_OPEN_EXTERNAL, token: "t1", url: "https://example.com/d" });
    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(openUrl).toHaveBeenLastCalledWith("https://example.com/d");
  });

  it("opens the normalised URL, never the raw string it validated (#296)", () => {
    renderFrame();
    const w = frameWindow();
    postAsIfFrom(w, { type: MSG_READY, token: "t1" });

    // `new URL` strips leading whitespace and embedded tabs/newlines and
    // lowercases scheme and host, so validating the raw text and opening the raw
    // text are not the same check. Whatever reaches the opener must be the parsed
    // form — this exact string.
    postAsIfFrom(w, { type: MSG_OPEN_EXTERNAL, token: "t1", url: "  htt\nps://EXAMPLE.com/x" });
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/x");
  });

  it("reports a failed open through the app's toasts instead of swallowing it (#296)", async () => {
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("no handler"));
    renderFrame();
    const w = frameWindow();
    postAsIfFrom(w, { type: MSG_READY, token: "t1" });
    postAsIfFrom(w, { type: MSG_OPEN_EXTERNAL, token: "t1", url: "https://example.com/dead" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(useToasts.getState().toasts.map((t) => t.variant)).toContain("error");
    expect(
      useToasts.getState().toasts.some((t) => t.message.includes("https://example.com/dead")),
    ).toBe(true);
  });

  it("re-arms the failure message when a reloaded frame's handshake is refused (#296)", () => {
    renderFrame();
    const w = frameWindow();
    postAsIfFrom(w, { type: MSG_READY, token: "t1" });
    tick(10000);
    expect(screen.queryByText(/didn't load/)).not.toBeInTheDocument();

    // A previewed page can `location.reload()` itself. The reloaded bootstrap's
    // handshake must be refused (it would otherwise rotate the token), but that
    // leaves a blank frame we will never deliver into again — so say so.
    postAsIfFrom(w, { type: MSG_READY, token: "t2" });
    expect(
      w.postMessage.mock.calls.filter(([m]) => (m as { type?: string })?.type === MSG_HTML),
    ).toHaveLength(1);
    tick(READY_TIMEOUT_MS + 1);
    expect(screen.getByRole("status")).toHaveTextContent(/didn't load/);
  });

  it("ignores messages from a foreign source (A21)", () => {
    renderFrame();
    const w = frameWindow();
    const foreign = { postMessage: vi.fn() };

    postAsIfFrom(foreign, { type: MSG_READY, token: "t1" });
    expect(w.postMessage).not.toHaveBeenCalled();

    postAsIfFrom(w, { type: MSG_READY, token: "t1" });
    postAsIfFrom(foreign, { type: MSG_OPEN_EXTERNAL, token: "t1", url: "https://evil.test/" });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("ignores messages carrying the wrong token, or none (A21)", () => {
    renderFrame();
    const w = frameWindow();
    postAsIfFrom(w, { type: MSG_READY, token: "t1" });

    postAsIfFrom(w, { type: MSG_OPEN_EXTERNAL, token: "other", url: "https://evil.test/" });
    postAsIfFrom(w, { type: MSG_OPEN_EXTERNAL, url: "https://evil.test/" });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("refuses to re-handshake, so the token cannot be rotated (A21)", () => {
    renderFrame();
    const w = frameWindow();
    postAsIfFrom(w, { type: MSG_READY, token: "t1" });
    w.postMessage.mockClear();

    // The previewed page shares the bootstrap's document, so it can forge this.
    postAsIfFrom(w, { type: MSG_READY, token: "forged" });
    expect(w.postMessage).not.toHaveBeenCalled();
    postAsIfFrom(w, { type: MSG_OPEN_EXTERNAL, token: "forged", url: "https://evil.test/" });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("opens only http(s) URLs — never javascript:, file:, data: or garbage (A21)", () => {
    renderFrame();
    const w = frameWindow();
    postAsIfFrom(w, { type: MSG_READY, token: "t1" });

    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>1</script>",
      "gamut-preview://localhost/",
      "not a url",
      "",
      42,
      null,
    ]) {
      postAsIfFrom(w, { type: MSG_OPEN_EXTERNAL, token: "t1", url });
    }
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("ignores malformed and unknown messages without throwing (A21)", () => {
    renderFrame();
    const w = frameWindow();
    for (const data of [null, undefined, "a string", 7, { type: "something-else" }, {}]) {
      postAsIfFrom(w, data);
    }
    expect(w.postMessage).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("surfaces a visible failure when ready never arrives (A26)", () => {
    renderFrame();
    expect(screen.queryByText(/didn't load/)).not.toBeInTheDocument();
    tick(5000);
    expect(screen.getByText(/didn't load/)).toBeInTheDocument();
  });

  it("shows no failure message once the handshake completes (A26)", () => {
    renderFrame();
    postAsIfFrom(frameWindow(), { type: MSG_READY, token: "t1" });
    tick(10000);
    expect(screen.queryByText(/didn't load/)).not.toBeInTheDocument();
  });
});
