import { useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";

import { cn } from "@/lib/utils";

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

export function Markdown({
  children,
  onToggleTask,
  className,
}: {
  children: string;
  /** When provided, task-list checkboxes become interactive. */
  onToggleTask?: (index: number, checked: boolean) => void;
  className?: string;
}) {
  // Reset on every render; the `input` override increments it in document order
  // so each checkbox knows its ordinal among the task items.
  const taskIndex = useRef(0);
  taskIndex.current = 0;

  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none break-words prose-pre:text-xs",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
        }}
      >
        {children || "_No description provided._"}
      </ReactMarkdown>
    </div>
  );
}
