//! Pure git-remote / GitHub-URL parsing, with no `State` or network access.
//!
//! Split out of `github/mod.rs` for navigability (#138): these are self-contained
//! string functions (host classification, remote-URL splitting, PR-URL parsing)
//! plus their unit tests. `owner_repo`, which resolves a repo's `origin` via
//! `State`, stays in `mod.rs` and calls into these.

use crate::process::NoWindow;

/// Whether `host` is GitHub, including custom SSH host aliases that resolve to
/// `github.com` (a common multi-identity setup, e.g. `rymera.github.com` or
/// `github.com-work` in `~/.ssh/config`). Non-GitHub hosts like `gitlab.com`
/// are rejected.
pub(super) fn is_github_host(host: &str) -> bool {
    host == "github.com" || host.ends_with(".github.com") || host.starts_with("github.com-")
}

/// The `host` part of an `https://host/...` URL, lowercased, with any userinfo
/// and `:port` stripped. Returns `None` for non-`https` URLs.
pub(super) fn https_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?; // drop optional user@
    let host = host.split(':').next()?; // drop optional :port
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// Whether `host` serves GitHub-hosted attachment/asset images. These are the
/// URLs embedded in issue/PR bodies (`github.com/user-attachments/assets/…`,
/// `*-user-images.githubusercontent.com`, `camo.githubusercontent.com`, …);
/// the authenticated ones 403 in a cookieless webview, so we proxy them with
/// the user's token. Restricting to GitHub hosts keeps this from being an open
/// proxy that would leak the token to arbitrary servers.
pub(super) fn is_github_asset_host(host: &str) -> bool {
    host == "github.com"
        || host.ends_with(".github.com")
        || host == "githubusercontent.com"
        || host.ends_with(".githubusercontent.com")
}

/// Split a git remote URL into its `(host, owner, repo)` components, supporting
/// the generic forms rather than keying on a literal `github.com` host:
///   https://host/owner/repo[.git]
///   ssh://[user@]host[:port]/owner/repo[.git]
///   git://host/owner/repo[.git]
///   [user@]host:owner/repo[.git]            (scp-like)
pub(super) fn split_remote(url: &str) -> Option<(String, String, String)> {
    let u = url.trim();

    let (host, path) = if let Some(rest) = u
        .strip_prefix("https://")
        .or_else(|| u.strip_prefix("http://"))
        .or_else(|| u.strip_prefix("ssh://"))
        .or_else(|| u.strip_prefix("git://"))
    {
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?; // drop optional user@
        let host = host.split(':').next()?; // drop optional :port
        (host, path)
    } else {
        // scp-like: [user@]host:owner/repo
        let (authority, path) = u.split_once(':')?;
        let host = authority.rsplit('@').next()?; // drop optional user@
        (host, path)
    };

    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.trim_matches('/').splitn(2, '/');
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.trim_end_matches('/').to_string();
    if host.is_empty() || owner.is_empty() || repo.is_empty() {
        None
    } else {
        Some((host.to_string(), owner, repo))
    }
}

/// `(owner, repo)` from a remote URL, but only when the host is GitHub.
pub(super) fn parse_owner_repo(url: &str) -> Option<(String, String)> {
    let (host, owner, repo) = split_remote(url)?;
    is_github_host(&host).then_some((owner, repo))
}

/// The `https://` web URL for a git remote, normalizing `git@…` / `ssh://` /
/// `git://` forms to their browser-openable equivalent. GitHub SSH host aliases
/// (`github.com-work`, `rymera.github.com`, …) canonicalize to `github.com`;
/// every other host passes through verbatim so GitLab / Bitbucket / self-hosted
/// remotes resolve to their own web host. Returns `None` when the URL can't be
/// split into host/owner/repo.
pub(super) fn remote_web_url(url: &str) -> Option<String> {
    let (host, owner, repo) = split_remote(url)?;
    let host = if is_github_host(&host) {
        "github.com".to_string()
    } else {
        host
    };
    Some(format!("https://{host}/{owner}/{repo}"))
}

/// Resolve an SSH host alias to its effective `HostName` via `ssh -G`, returning
/// true if that resolves to a GitHub host. This handles arbitrarily-named
/// aliases (e.g. `Host mygit` → `HostName github.com`) that the `is_github_host`
/// name heuristic can't recognise. Returns false if `ssh` is unavailable or the
/// alias doesn't resolve to GitHub — callers fall back to the name heuristic.
pub(super) fn ssh_alias_resolves_to_github(host: &str) -> bool {
    let Ok(output) = std::process::Command::new("ssh")
        .arg("-G")
        .arg(host)
        .no_window()
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        let mut it = line.split_whitespace();
        // `ssh -G` lowercases keys, e.g. `hostname github.com`.
        matches!(it.next(), Some("hostname")) && it.next().is_some_and(is_github_host)
    })
}

/// Parse a GitHub **pull request** web URL into `(owner, repo, number)`.
/// Accepts the canonical `https://github.com/<owner>/<repo>/pull/<n>` form plus
/// any trailing path/query/fragment (`/files`, `#discussion_r…`). Returns `None`
/// for non-GitHub hosts, non-`https` URLs, or any non-PR path (issues, commits…).
pub(super) fn parse_pr_url(url: &str) -> Option<(String, String, i64)> {
    let host = https_host(url)?;
    if !is_github_host(&host) {
        return None;
    }
    let rest = url.strip_prefix("https://")?;
    let path = rest.split_once('/')?.1;
    // Strip query/fragment, then take the leading path segments.
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let mut parts = path.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    if parts.next()? != "pull" {
        return None;
    }
    let number: i64 = parts.next()?.parse().ok()?;
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_string(), repo.to_string(), number))
}

#[cfg(test)]
mod tests {
    use super::{
        https_host, is_github_asset_host, parse_owner_repo, parse_pr_url, remote_web_url,
        split_remote,
    };

    #[test]
    fn extracts_https_host() {
        assert_eq!(
            https_host("https://github.com/user-attachments/assets/abc"),
            Some("github.com".to_string())
        );
        assert_eq!(
            https_host("https://private-user-images.githubusercontent.com/1/2?jwt=x"),
            Some("private-user-images.githubusercontent.com".to_string())
        );
        // userinfo and port are stripped; host is lowercased.
        assert_eq!(
            https_host("https://user@GitHub.com:443/x"),
            Some("github.com".to_string())
        );
        // Non-https (e.g. data:, http:) is not proxied.
        assert_eq!(https_host("http://github.com/x"), None);
        assert_eq!(https_host("data:image/png;base64,AAAA"), None);
    }

    #[test]
    fn recognizes_github_asset_hosts() {
        for host in [
            "github.com",
            "githubusercontent.com",
            "private-user-images.githubusercontent.com",
            "user-images.githubusercontent.com",
            "camo.githubusercontent.com",
        ] {
            assert!(is_github_asset_host(host), "should accept {host}");
        }
        // Anything else must be rejected so the token isn't leaked to it.
        for host in [
            "evil.com",
            "githubusercontent.com.evil.com",
            "notgithub.com",
            "raw.githubusercontent.com.attacker.net",
        ] {
            assert!(!is_github_asset_host(host), "should reject {host}");
        }
    }

    #[test]
    fn splits_arbitrary_host_aliases() {
        // split_remote is host-agnostic: it extracts owner/repo even for an
        // arbitrarily-named SSH alias. owner_repo then resolves the alias via
        // `ssh -G` to decide whether it's really GitHub.
        assert_eq!(
            split_remote("mygit:rymera/gamut.git"),
            Some((
                "mygit".to_string(),
                "rymera".to_string(),
                "gamut".to_string()
            ))
        );
        assert_eq!(
            split_remote("ssh://git@mygit/rymera/gamut.git"),
            Some((
                "mygit".to_string(),
                "rymera".to_string(),
                "gamut".to_string()
            ))
        );
    }

    #[test]
    fn parses_github_remotes() {
        let cases = [
            "https://github.com/rymera/gamut.git",
            "https://github.com/rymera/gamut",
            "git@github.com:rymera/gamut.git",
            "ssh://git@github.com/rymera/gamut.git",
            // Custom SSH host aliases that resolve to github.com (issue #4).
            "rymera.github.com:rymera/gamut.git",
            "rymera.github.com:rymera/gamut",
            "git@rymera.github.com:rymera/gamut.git",
            "ssh://git@rymera.github.com/rymera/gamut.git",
            "github.com-work:rymera/gamut.git",
        ];
        for c in cases {
            assert_eq!(
                parse_owner_repo(c),
                Some(("rymera".to_string(), "gamut".to_string())),
                "failed for {c}"
            );
        }
        // Genuinely non-GitHub remotes must still be rejected.
        assert_eq!(parse_owner_repo("https://gitlab.com/x/y.git"), None);
        assert_eq!(parse_owner_repo("git@gitlab.com:x/y.git"), None);
        assert_eq!(parse_owner_repo("rymera.gitlab.com:x/y.git"), None);
    }

    #[test]
    fn builds_remote_web_urls() {
        // GitHub remotes in every scp/ssh/https form normalize to the same
        // browser URL, and SSH host aliases canonicalize to github.com.
        for url in [
            "https://github.com/rymera/gamut.git",
            "https://github.com/rymera/gamut",
            "git@github.com:rymera/gamut.git",
            "ssh://git@github.com/rymera/gamut.git",
            "rymera.github.com:rymera/gamut.git",
            "git@rymera.github.com:rymera/gamut.git",
            "github.com-work:rymera/gamut.git",
        ] {
            assert_eq!(
                remote_web_url(url).as_deref(),
                Some("https://github.com/rymera/gamut"),
                "failed for {url}"
            );
        }
        // Non-GitHub hosts pass through to their own web host.
        assert_eq!(
            remote_web_url("git@gitlab.com:group/proj.git").as_deref(),
            Some("https://gitlab.com/group/proj")
        );
        assert_eq!(
            remote_web_url("https://bitbucket.org/team/repo.git").as_deref(),
            Some("https://bitbucket.org/team/repo")
        );
        assert_eq!(
            remote_web_url("ssh://git@git.example.com:2222/owner/repo.git").as_deref(),
            Some("https://git.example.com/owner/repo")
        );
        // Unparseable remotes yield nothing so the caller hides the menu item.
        assert_eq!(remote_web_url("not a url"), None);
        assert_eq!(remote_web_url(""), None);
    }

    #[test]
    fn parses_pr_urls() {
        // Canonical PR URL plus trailing path, query and fragment variants.
        for url in [
            "https://github.com/Rymera-Web-Co/Gamut/pull/51",
            "https://github.com/Rymera-Web-Co/Gamut/pull/51/files",
            "https://github.com/Rymera-Web-Co/Gamut/pull/51#discussion_r123",
            "https://github.com/Rymera-Web-Co/Gamut/pull/51?w=1",
        ] {
            assert_eq!(
                parse_pr_url(url),
                Some(("Rymera-Web-Co".to_string(), "Gamut".to_string(), 51)),
                "failed for {url}"
            );
        }
        // Custom github host alias is still GitHub.
        assert_eq!(
            parse_pr_url("https://github.com-work/o/r/pull/7"),
            Some(("o".to_string(), "r".to_string(), 7))
        );
    }

    #[test]
    fn rejects_non_pr_urls() {
        for url in [
            // Not a PR path.
            "https://github.com/o/r/issues/3",
            "https://github.com/o/r/commit/abc",
            "https://github.com/o/r",
            // Non-numeric / missing PR number.
            "https://github.com/o/r/pull/",
            "https://github.com/o/r/pull/abc",
            // Non-GitHub host.
            "https://gitlab.com/o/r/pull/3",
            // Non-https (terminal links can be http; PR deep-linking is https-only).
            "http://github.com/o/r/pull/3",
        ] {
            assert_eq!(parse_pr_url(url), None, "should reject {url}");
        }
    }
}
