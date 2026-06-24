import { useState } from "react";
import { Loader2, LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { toast } from "@/store/toast";
import { useGithubAuth, useLogout } from "@/features/review/api";
import { Divider, Field, NumberField, PanelTitle, TextField, useSetting } from "../controls";

export function GitHubPanel() {
  const [apiBase, setApiBase] = useSetting("githubApiBase");
  const [graphqlBase, setGraphqlBase] = useSetting("githubGraphqlBase");
  const [prPageSize, setPrPageSize] = useSetting("githubPrPageSize");
  const auth = useGithubAuth();
  const logout = useLogout();
  const [checking, setChecking] = useState(false);

  const connected = auth.data?.logged_in ?? false;

  const testConnection = async () => {
    setChecking(true);
    try {
      const status = await ipc.githubCheck();
      auth.refetch();
      toast.success(`Connected as ${status.login} ✓`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div>
      <PanelTitle>GitHub</PanelTitle>
      <p className="mb-2 text-xs text-[var(--color-muted-foreground)]">
        Point Gamut at a GitHub Enterprise Server by overriding the API and GraphQL endpoints. Leave
        blank to use github.com. Sign in from the GitHub button in the sidebar; on Enterprise, use a
        personal-access token.
      </p>

      <Field label="Account">
        {connected ? (
          <div className="flex items-center gap-2">
            <span className="text-sm">
              Signed in as <span className="font-medium">{auth.data?.login}</span>
            </span>
            <Button variant="outline" size="sm" className="h-8" onClick={() => logout.mutate()}>
              <LogOut className="size-3.5" />
              Sign out
            </Button>
          </div>
        ) : (
          <span className="text-sm text-[var(--color-muted-foreground)]">Not connected</span>
        )}
      </Field>
      <Divider />
      <Field label="API base URL" hint="REST endpoint. e.g. https://ghe.example.com/api/v3">
        <TextField
          value={apiBase}
          onChange={setApiBase}
          placeholder="https://api.github.com"
          wide
        />
      </Field>
      <Field label="GraphQL endpoint" hint="e.g. https://ghe.example.com/api/graphql">
        <TextField
          value={graphqlBase}
          onChange={setGraphqlBase}
          placeholder="https://api.github.com/graphql"
          wide
        />
      </Field>
      <Field label="Verify" hint="Check the stored token reaches the configured host.">
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          disabled={!connected || checking}
          onClick={() => void testConnection()}
        >
          {checking ? <Loader2 className="animate-spin" /> : null}
          Test connection
        </Button>
      </Field>
      <Divider />
      <Field label="PR list page size" hint="Open pull requests fetched per repository (1–100).">
        <NumberField value={prPageSize} onChange={setPrPageSize} min={1} max={100} suffix="PRs" />
      </Field>
    </div>
  );
}
