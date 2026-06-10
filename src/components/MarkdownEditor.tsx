import { useEffect, useRef, useState } from "react";
import {
  AtSign,
  Bold,
  Code,
  Heading,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  Quote,
} from "lucide-react";

import { Markdown } from "@/components/Markdown";
import { cn } from "@/lib/utils";

type Tab = "write" | "preview";

/** Apply a markdown transform to the current textarea selection. */
type Edit = {
  /** Wrap the selection, e.g. `**` for bold or `` ` `` for code. */
  wrap?: string;
  /** Distinct prefix/suffix wrap (overrides `wrap`), e.g. `[`…`](url)`. */
  prefix?: string;
  suffix?: string;
  /** Prepend to the start of every selected line, e.g. `- ` or `> `. */
  linePrefix?: string;
  /** Placeholder inserted when there's no selection. */
  placeholder?: string;
};

function applyEdit(
  value: string,
  start: number,
  end: number,
  edit: Edit,
): { value: string; selStart: number; selEnd: number } {
  const selected = value.slice(start, end) || edit.placeholder || "";

  if (edit.linePrefix) {
    // Extend the range to whole lines, then prefix each line.
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const block = value.slice(lineStart, end);
    const prefixed = block
      .split("\n")
      .map((l) => `${edit.linePrefix}${l}`)
      .join("\n");
    const next = value.slice(0, lineStart) + prefixed + value.slice(end);
    return { value: next, selStart: lineStart, selEnd: lineStart + prefixed.length };
  }

  const pre = edit.prefix ?? edit.wrap ?? "";
  const suf = edit.suffix ?? edit.wrap ?? "";
  const next = value.slice(0, start) + pre + selected + suf + value.slice(end);
  return {
    value: next,
    selStart: start + pre.length,
    selEnd: start + pre.length + selected.length,
  };
}

/** The `@mention` token immediately before the caret, if any. */
function activeMention(
  value: string,
  caret: number,
): { query: string; start: number; end: number } | null {
  const m = value.slice(0, caret).match(/(?:^|\s)@([\w-]*)$/);
  if (!m) return null;
  const query = m[1];
  return { query, start: caret - query.length - 1, end: caret };
}

const MAX_SUGGESTIONS = 7;

const TOOLBAR: { icon: typeof Bold; title: string; edit: Edit }[] = [
  { icon: Heading, title: "Heading", edit: { linePrefix: "### " } },
  { icon: Bold, title: "Bold", edit: { wrap: "**", placeholder: "text" } },
  { icon: Italic, title: "Italic", edit: { wrap: "_", placeholder: "text" } },
  { icon: Code, title: "Code", edit: { wrap: "`", placeholder: "code" } },
  {
    icon: LinkIcon,
    title: "Link",
    edit: { prefix: "[", suffix: "](url)", placeholder: "text" },
  },
  { icon: Quote, title: "Quote", edit: { linePrefix: "> " } },
  { icon: List, title: "Bulleted list", edit: { linePrefix: "- " } },
  { icon: ListOrdered, title: "Numbered list", edit: { linePrefix: "1. " } },
  { icon: ListTodo, title: "Task list", edit: { linePrefix: "- [ ] " } },
  { icon: AtSign, title: "Mention a user", edit: { prefix: "@", placeholder: "" } },
];

export function MarkdownEditor({
  value,
  onChange,
  placeholder = "Leave a comment",
  autoFocus,
  minHeight = "min-h-32",
  mentions = [],
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  minHeight?: string;
  /** Logins offered by the `@`-mention autocomplete. */
  mentions?: string[];
}) {
  const [tab, setTab] = useState<Tab>("write");
  const ref = useRef<HTMLTextAreaElement>(null);
  // Selection to restore after a toolbar edit re-renders the (controlled) value.
  const pendingSel = useRef<[number, number] | null>(null);

  // Active `@mention` token + the highlighted suggestion.
  const [mention, setMention] = useState<ReturnType<typeof activeMention>>(null);
  const [hi, setHi] = useState(0);

  const suggestions = mention
    ? mentions
        .filter((u) => u.toLowerCase().includes(mention.query.toLowerCase()))
        .slice(0, MAX_SUGGESTIONS)
    : [];
  const showMenu = tab === "write" && suggestions.length > 0;

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (pendingSel.current && ref.current) {
      const [s, e] = pendingSel.current;
      ref.current.focus();
      ref.current.setSelectionRange(s, e);
      pendingSel.current = null;
    }
  });

  function runEdit(edit: Edit) {
    const el = ref.current;
    if (!el) return;
    const { value: next, selStart, selEnd } = applyEdit(
      value,
      el.selectionStart,
      el.selectionEnd,
      edit,
    );
    pendingSel.current = [selStart, selEnd];
    onChange(next);
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value);
    setMention(activeMention(e.target.value, e.target.selectionStart));
    setHi(0);
  }

  function acceptMention(login: string) {
    if (!mention) return;
    const insert = `@${login} `;
    const next = value.slice(0, mention.start) + insert + value.slice(mention.end);
    pendingSel.current = [
      mention.start + insert.length,
      mention.start + insert.length,
    ];
    onChange(next);
    setMention(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!showMenu) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      acceptMention(suggestions[hi]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setMention(null);
    }
  }

  return (
    <div className="rounded-md border border-[var(--color-input)] focus-within:ring-2 focus-within:ring-[var(--color-ring)]">
      <div className="flex items-center gap-1 border-b px-1.5 py-1">
        <div className="flex">
          {(["write", "preview"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "rounded px-2 py-1 text-xs font-medium capitalize",
                tab === t
                  ? "bg-[var(--color-accent)] text-[var(--color-foreground)]"
                  : "text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]",
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "write" && (
          <div className="ml-auto flex items-center">
            {TOOLBAR.map(({ icon: Icon, title, edit }) => (
              <button
                key={title}
                type="button"
                title={title}
                aria-label={title}
                // Keep textarea focus/selection when clicking a toolbar button.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runEdit(edit)}
                className="flex size-7 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
              >
                <Icon className="size-3.5" />
              </button>
            ))}
          </div>
        )}
      </div>

      {tab === "write" ? (
        <div className="relative">
          <textarea
            ref={ref}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onBlur={() => setMention(null)}
            onSelect={(e) =>
              setMention(
                activeMention(
                  e.currentTarget.value,
                  e.currentTarget.selectionStart,
                ),
              )
            }
            placeholder={placeholder}
            className={cn(
              "w-full resize-y rounded-b-md bg-transparent p-2 text-sm focus-visible:outline-none",
              minHeight,
            )}
          />
          {showMenu && (
            <ul className="absolute left-2 top-full z-50 mt-1 max-h-48 w-56 overflow-auto rounded-md border bg-[var(--color-popover)] py-1 shadow-md">
              {suggestions.map((login, i) => (
                <li key={login}>
                  <button
                    type="button"
                    // mousedown fires before the textarea's blur clears the menu.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptMention(login);
                    }}
                    onMouseEnter={() => setHi(i)}
                    className={cn(
                      "flex w-full items-center gap-1 px-2 py-1 text-left text-sm",
                      i === hi
                        ? "bg-[var(--color-accent)]"
                        : "hover:bg-[var(--color-accent)]",
                    )}
                  >
                    <span className="text-[var(--color-muted-foreground)]">@</span>
                    {login}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className={cn("overflow-auto p-2", minHeight)}>
          {value.trim() ? (
            <Markdown>{value}</Markdown>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Nothing to preview.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
