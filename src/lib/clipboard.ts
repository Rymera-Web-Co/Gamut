import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import { toast } from "@/store/toast";

/** Copy text to the clipboard and show a confirmation toast. */
export async function copy(text: string, label?: string) {
  try {
    await writeText(text);
  } catch {
    // Fallback to the browser clipboard API.
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      toast.error("Could not copy to clipboard");
      return;
    }
  }
  toast.success(label ?? "Copied to clipboard");
}
