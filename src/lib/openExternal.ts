import { openUrl } from "@tauri-apps/plugin-opener";

import { toast } from "@/store/toast";

/** Open `url` in the user's browser. Show an error toast when it fails. */
export function openExternal(url: string): Promise<void> {
  return openUrl(url).catch((e) => {
    toast.error(`Couldn't open ${url} — ${String(e)}`);
  });
}
