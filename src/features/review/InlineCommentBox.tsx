import { useState } from "react";
import { Loader2 } from "lucide-react";

import { MarkdownEditor } from "@/components/MarkdownEditor";
import { Button } from "@/components/ui/button";

export function InlineCommentBox({
  lineLabel,
  mentions,
  hasDrafts,
  posting,
  onCancel,
  onComment,
  onAddDraft,
}: {
  lineLabel: string;
  mentions: string[];
  /** Whether a pending review already has drafts (changes the button label). */
  hasDrafts: boolean;
  /** An immediate "Comment" post is in flight. */
  posting: boolean;
  onCancel: () => void;
  onComment: (body: string) => void;
  onAddDraft: (body: string) => void;
}) {
  const [body, setBody] = useState("");
  const empty = body.trim().length === 0;

  return (
    <div className="rounded-md border bg-[var(--color-popover)] p-2 shadow-lg">
      <div className="mb-1.5 text-sm font-semibold">
        Add a comment on line {lineLabel}
      </div>
      <MarkdownEditor
        value={body}
        onChange={setBody}
        autoFocus
        minHeight="min-h-24"
        mentions={mentions}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={empty || posting}
          onClick={() => onComment(body)}
        >
          {posting && <Loader2 className="animate-spin" />}
          Comment
        </Button>
        <Button size="sm" disabled={empty} onClick={() => onAddDraft(body)}>
          {hasDrafts ? "Add review comment" : "Start a review"}
        </Button>
      </div>
    </div>
  );
}
