# Homebrew distribution

Gamut is distributed for macOS through a **Homebrew Cask** in our own tap,
[`Rymera-Web-Co/homebrew-gamut`](https://github.com/Rymera-Web-Co/homebrew-gamut).

```bash
brew install --cask rymera-web-co/gamut/gamut
xattr -dr com.apple.quarantine /Applications/Gamut.app   # one-time, see below
brew upgrade --cask gamut
```

This is **Option A** from [#3](https://github.com/Rymera-Web-Co/Gamut/issues/3):
ship via Homebrew at zero cost and with no Apple Developer Program.

> **Reality check (the original #3 premise was wrong).** Modern Homebrew Cask
> applies `com.apple.quarantine` by default, and **Homebrew 6 removed the
> `--no-quarantine` opt-out entirely** — there is no install flag or env var to
> disable it anymore. So on an unsigned build, `brew install` is quarantined just
> like a browser download, and Gatekeeper blocks the first launch. The cask ships
> a `caveats` stanza that prints the one-time `xattr` fix after install.
>
> We deliberately **do not** auto-strip quarantine from a `postflight` hook: that
> would silently bypass Gatekeeper for every user. The only way to make a plain
> `brew install --cask` (and double-click) work with no extra step *and* keep
> Gatekeeper intact is Developer ID signing + notarization (Option B). Until then,
> Homebrew buys easy install/upgrade/removal — not a frictionless first launch.

## Why our own tap (not `homebrew/cask`)

A "tap" is just a Git repo with a `Casks/` folder. We publish to our own tap, so
**there is nothing to submit to Homebrew and no review to pass**:

- **Own tap** (what we do) — full control, instant publishing, longer install
  command the first time (`rymera-web-co/gamut/gamut`). Best for an alpha.
- **Official `homebrew/cask`** — `brew install --cask gamut` with no prefix, but
  requires a PR to Homebrew and meeting their notability bar (a real user base,
  stable versioned releases). Revisit once Gamut is established.

## How publishing works

The cask's shape lives in one place: [`scripts/update-cask.sh`](../scripts/update-cask.sh).
On every tag push, the `publish-cask` job in
[`.github/workflows/release.yml`](../.github/workflows/release.yml):

1. waits for the build job to attach the `.dmg` assets to the GitHub Release,
2. runs `update-cask.sh <tag>` to download those `.dmg`s, compute their SHA256s,
   and render `Casks/gamut.rb`,
3. clones the tap repo and pushes the updated cask.

### The version string

The `.dmg` filename embeds the **app version** (`0.1.0`, from
`tauri.conf.json`), while the release **URL uses the tag** (`alpha-0.3`). These
are decoupled, so the cask uses a two-value version:

```ruby
version "0.1.0,alpha-0.3"   # version.csv.first = .dmg version, .second = tag
```

When either changes, the version string changes, so `brew upgrade` sees the new
release.

## One-time setup

The CI publish step needs the tap repo to exist and a token that can push to it:

1. **Create the tap repo.** A public repo named exactly
   `Rymera-Web-Co/homebrew-gamut` (the `homebrew-` prefix is what makes
   `brew tap rymera-web-co/gamut` work). An empty repo with a README is fine —
   the first release populates `Casks/gamut.rb`.

2. **Add the `HOMEBREW_TAP_TOKEN` secret** to the **Gamut** repo
   (Settings → Secrets and variables → Actions). The built-in `GITHUB_TOKEN`
   can't push to a different repo, so use one of:
   - a **fine-grained PAT** scoped to `homebrew-gamut` only, with
     **Contents: Read and write**, or
   - a deploy key / machine-user token with write access to the tap.

## Manual publish / bootstrap

To seed the tap by hand, or to republish a specific release:

```bash
# from the Gamut repo, with `gh` authenticated:
scripts/update-cask.sh alpha-0.3 /path/to/homebrew-gamut/Casks/gamut.rb

cd /path/to/homebrew-gamut
git add Casks/gamut.rb && git commit -m "gamut alpha-0.3" && git push
```

Validate the generated cask before pushing:

```bash
brew style Casks/gamut.rb                 # run from inside the tap repo
brew audit --cask --online rymera-web-co/gamut/gamut
```

`brew style` passes clean. Two `brew audit --online` advisories are **expected**
and not worth chasing while we ship unsigned alphas:

- *"Version '…' differs from '…' retrieved by livecheck"* — the cask version is
  `<app-version>,<release-tag>` to handle the decoupled `.dmg`-name vs URL-tag.
  `brew upgrade` compares against the CI-bumped version in the tap, not
  livecheck, so upgrades work regardless.
- *"… is a GitHub pre-release"* — all releases are prereleases during the alpha.
  Goes away once we cut a stable, non-prerelease tag.

(`brew audit` is the strict gate for submitting to the official `homebrew/cask`;
for our own tap these are informational.)

## Notes

- **Ad-hoc signing on Apple Silicon** — Tauri ad-hoc signs the binary during
  `tauri build`, which satisfies the kernel's "must be signed to run" rule. Note
  the bundle is only `linker-signed` (`Sealed Resources=none`), so Gatekeeper
  still rejects it *when quarantined* — hence the one-time `xattr` step. Proper
  bundle signing comes with Option B.
- **Auto-update (#1)** and a step-free `brew install --cask` / double-click `.dmg`
  both require Developer ID signing + notarization (Option B in #3). The cask
  path doesn't block that — it's an independent, lower-cost first step, but it
  does not by itself remove the one-time `xattr` requirement.
