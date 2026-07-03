import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Github, Loader2, LogOut, ExternalLink, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { copy } from "@/lib/clipboard";
import { ipc, type DeviceCode } from "@/lib/ipc";
import { toast } from "@/store/toast";
import { useGithubAuth, useLogout, useSetToken } from "@/features/review/api";

function ConnectBody({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const oauth = useQuery({
    queryKey: ["github-oauth-available"],
    queryFn: ipc.githubOauthAvailable,
  });
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [token, setToken] = useState("");

  const setTokenMut = useSetToken();

  const poll = useMutation({
    mutationFn: (d: DeviceCode) => ipc.githubDevicePoll(d.device_code, d.interval, d.expires_in),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["github-auth"] });
      toast.success("Connected to GitHub");
      setDevice(null);
      onDone();
    },
    onError: () => setDevice(null),
  });

  const start = useMutation({
    mutationFn: ipc.githubDeviceStart,
    onSuccess: (d) => {
      setDevice(d);
      openUrl(d.verification_uri_complete ?? d.verification_uri).catch(() => {});
      poll.mutate(d);
    },
  });

  // Device-flow in progress: show the code and wait.
  if (device) {
    return (
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Enter this code on GitHub to authorize Gamut:
        </p>
        <button
          onClick={() => copy(device.user_code, "Copied code")}
          className="flex items-center gap-2 rounded-md border px-4 py-2 font-mono text-lg font-semibold tracking-widest hover:bg-[var(--color-accent)]"
          title="Copy code"
        >
          {device.user_code}
          <Copy className="size-4 text-[var(--color-muted-foreground)]" />
        </button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => openUrl(device.verification_uri_complete ?? device.verification_uri)}
        >
          <ExternalLink /> Open GitHub
        </Button>
        <p className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
          <Loader2 className="size-3.5 animate-spin" /> Waiting for authorization…
        </p>
      </div>
    );
  }

  if (oauth.data) {
    return (
      <div className="flex flex-col gap-3 py-2">
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Authorize Gamut in your browser to connect your GitHub account.
        </p>
        <Button onClick={() => start.mutate()} disabled={start.isPending}>
          {start.isPending ? <Loader2 className="animate-spin" /> : <Github />}
          Connect with GitHub
        </Button>
      </div>
    );
  }

  // No OAuth client configured — fall back to a personal-access token.
  return (
    <div className="flex flex-col gap-3 py-2">
      <p className="text-sm text-[var(--color-muted-foreground)]">
        Paste a GitHub personal-access token (with <code>repo</code> and <code>read:org</code>{" "}
        scopes). It's stored in your OS keychain.
      </p>
      <div className="flex gap-2">
        <Input
          type="password"
          placeholder="ghp_…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) =>
            e.key === "Enter" && token && setTokenMut.mutate(token, { onSuccess: onDone })
          }
        />
        <Button
          onClick={() => setTokenMut.mutate(token, { onSuccess: onDone })}
          disabled={!token || setTokenMut.isPending}
        >
          Sign in
        </Button>
      </div>
    </div>
  );
}

export function GitHubConnect() {
  const auth = useGithubAuth();
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const [avatarBroken, setAvatarBroken] = useState(false);
  const connected = auth.data?.logged_in ?? false;
  const login = auth.data?.login;

  // A broken avatar for one account shouldn't stick around after switching accounts.
  useEffect(() => {
    setAvatarBroken(false);
  }, [login]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          title={connected ? `GitHub: ${login ?? "Connected"}` : "Connect to GitHub"}
          className="relative mt-1 flex size-10 items-center justify-center rounded-lg text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
        >
          <Github className="size-5" />
          {/* Amber dot only when disconnected — signals "action needed: connect".
              Once signed in (or while auth is still loading) there's nothing to
              act on yet, so no dot. */}
          {!auth.isLoading && !connected && (
            <span className="absolute bottom-1 right-1 size-2 rounded-full border border-[var(--color-sidebar)] bg-[#f59e0b]" />
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="right"
        align="end"
        sideOffset={8}
        aria-label="GitHub account"
        className="w-72 p-3"
      >
        {connected ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              {login && !avatarBroken ? (
                <img
                  src={`https://github.com/${login}.png`}
                  alt=""
                  onError={() => setAvatarBroken(true)}
                  className="size-9 shrink-0 rounded-full"
                />
              ) : (
                <Github className="size-9 shrink-0 rounded-full border p-1.5" />
              )}
              <span className="truncate font-medium">{login ?? "Connected"}</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!login}
              onClick={() => login && openUrl(`https://github.com/${login}`)}
            >
              <ExternalLink /> View on GitHub
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => logout.mutate(undefined, { onSuccess: () => setOpen(false) })}
            >
              <LogOut /> Sign out
            </Button>
          </div>
        ) : (
          <ConnectBody onDone={() => setOpen(false)} />
        )}
      </PopoverContent>
    </Popover>
  );
}
