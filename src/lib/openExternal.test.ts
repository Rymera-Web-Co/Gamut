import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/store/toast", () => ({ toast: { error: vi.fn() } }));

import { openUrl } from "@tauri-apps/plugin-opener";

import { toast } from "@/store/toast";

import { openExternal } from "./openExternal";

describe("openExternal", () => {
  beforeEach(() => {
    vi.mocked(openUrl).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("opens the URL and shows no toast on success", async () => {
    vi.mocked(openUrl).mockResolvedValue(undefined);
    await openExternal("https://example.com");
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows an error toast with the error text on failure", async () => {
    vi.mocked(openUrl).mockRejectedValue(new Error("not allowed"));
    await openExternal("https://example.com");
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't open https://example.com — Error: not allowed",
    );
  });
});
