import { useEffect, useRef, useState, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { openUrl } from "@tauri-apps/plugin-opener";

import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
};

/**
 * remark plugin: turn `#123` references into links to `${base}/123`
 * (GitHub's /issues/N resolves to PRs too). Skips text inside code and
 * existing links.
 */
function remarkIssueRefs(base: string) {
  const re = /(?<![A-Za-z0-9_])#(\d+)\b/g;

  function split(value: string): MdNode[] {
    const out: MdNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(value))) {
      if (m.index > last) {
        out.push({ type: "text", value: value.slice(last, m.index) });
      }
      out.push({
        type: "link",
        url: `${base}/${m[1]}`,
        children: [{ type: "text", value: m[0] }],
      });
      last = m.index + m[0].length;
    }
    if (out.length === 0) return [{ type: "text", value }];
    if (last < value.length) out.push({ type: "text", value: value.slice(last) });
    return out;
  }

  function walk(node: MdNode) {
    if (!node.children || node.type === "link") return;
    const next: MdNode[] = [];
    for (const child of node.children) {
      if (child.type === "text" && child.value != null) {
        next.push(...split(child.value));
      } else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  }

  return (tree: MdNode) => walk(tree);
}

/** Regex matching a single task-list marker, e.g. `- [ ]`, `* [x]`, `1. [X]`. */
const TASK_MARKER = /^(\s*(?:[-*+]|\d+[.)])\s+\[)( |x|X)(\])/;

/**
 * Flip the `index`-th task-list checkbox in a markdown source string.
 * react-markdown renders checkboxes in document order, which is the same order
 * the markers appear in the source — so the rendered checkbox's ordinal maps
 * straight back to the Nth marker here.
 */
export function toggleTaskInMarkdown(source: string, index: number): string {
  let n = -1;
  return source
    .split("\n")
    .map((line) => {
      if (!TASK_MARKER.test(line)) return line;
      n += 1;
      if (n !== index) return line;
      return line.replace(TASK_MARKER, (_m, pre, mark, post) => {
        const checked = mark !== " ";
        return `${pre}${checked ? " " : "x"}${post}`;
      });
    })
    .join("\n");
}

/**
 * Whether `url` points at a GitHub-hosted attachment/asset image. These render
 * fine on github.com (the browser sends session cookies) but break in the
 * cookieless Tauri webview, so they're proxied through the backend with the
 * user's token. Non-GitHub images (badges, external hosts) load directly.
 */
function isGithubAssetUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "github.com" ||
      host.endsWith(".github.com") ||
      host === "githubusercontent.com" ||
      host.endsWith(".githubusercontent.com")
    );
  } catch {
    return false;
  }
}

// Dedupe and cache proxied-image fetches across renders/mounts: a markdown body
// often re-renders (task toggles, refetches) and the same screenshot shouldn't
// be re-downloaded each time.
const imageCache = new Map<string, Promise<string>>();

function fetchProxiedImage(url: string): Promise<string> {
  let p = imageCache.get(url);
  if (!p) {
    p = ipc.githubFetchImage(url).catch((e) => {
      imageCache.delete(url); // allow a retry on the next mount
      throw e;
    });
    imageCache.set(url, p);
  }
  return p;
}

/**
 * An `<img>` whose source is a GitHub attachment URL, fetched via the backend
 * (with auth) and shown as a data URL. Falls back to a link to the asset if the
 * fetch fails so the image is at least reachable.
 */
function GitHubImage({ src, alt, ...props }: ComponentProps<"img">) {
  const [resolved, setResolved] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (typeof src !== "string") return;
    let active = true;
    setResolved(null);
    setFailed(false);
    fetchProxiedImage(src)
      .then((dataUrl) => active && setResolved(dataUrl))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [src]);

  if (failed) {
    return (
      <a
        href={typeof src === "string" ? src : undefined}
        title={props.title}
        onClick={(e) => {
          e.preventDefault();
          if (typeof src === "string") openUrl(src).catch(() => {});
        }}
      >
        {alt || "View image"}
      </a>
    );
  }
  if (!resolved) {
    return (
      <span className="text-xs text-[var(--color-muted-foreground)]">
        Loading image…
      </span>
    );
  }
  return <img src={resolved} alt={alt} {...props} />;
}

export function Markdown({
  children,
  onToggleTask,
  className,
  issueBaseUrl,
}: {
  children: string;
  /** When provided, task-list checkboxes become interactive. */
  onToggleTask?: (index: number, checked: boolean) => void;
  className?: string;
  /** When set, `#123` references link to `${issueBaseUrl}/123`. */
  issueBaseUrl?: string;
}) {
  // Reset on every render; the `input` override increments it in document order
  // so each checkbox knows its ordinal among the task items.
  const taskIndex = useRef(0);
  taskIndex.current = 0;

  const remarkPlugins = (
    issueBaseUrl ? [remarkGfm, [remarkIssueRefs, issueBaseUrl]] : [remarkGfm]
  ) as ComponentProps<typeof ReactMarkdown>["remarkPlugins"];

  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none break-words prose-pre:text-xs",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeRaw]}
        components={{
          input(props) {
            if (props.type !== "checkbox") return <input {...props} />;
            const index = taskIndex.current++;
            return (
              <input
                type="checkbox"
                checked={!!props.checked}
                disabled={!onToggleTask}
                onChange={(e) =>
                  onToggleTask?.(index, e.currentTarget.checked)
                }
              />
            );
          },
          // GitHub attachment images need an authenticated fetch (the webview
          // has no github.com cookies); other images load directly. (issue #36)
          img({ node: _node, src, alt, ...props }) {
            if (typeof src === "string" && isGithubAssetUrl(src)) {
              return <GitHubImage src={src} alt={alt} {...props} />;
            }
            return <img src={src} alt={alt} {...props} />;
          },
          // Open all links in the external browser, not the app webview.
          a({ href, children }) {
            return (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  if (href) openUrl(href).catch(() => {});
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {children || "_No description provided._"}
      </ReactMarkdown>
    </div>
  );
}
