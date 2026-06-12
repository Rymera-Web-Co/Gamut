# Homebrew distribution

Gamut is distributed for macOS through a **Homebrew Cask** in our own tap,
[`Rymera-Web-Co/homebrew-gamut`](https://github.com/Rymera-Web-Co/homebrew-gamut).

```bash
brew install --cask rymera-web-co/gamut/gamut
brew upgrade --cask gamut
```

This is **Option A** from [#3](https://github.com/Rymera-Web-Co/Gamut/issues/3): it
removes the Gatekeeper "damaged app" friction at zero cost and with no Apple
Developer Program. Homebrew downloads the `.dmg` without setting the
`com.apple.quarantine` flag, so the unsigned (ad-hoc-signed) build launches
normally — no Settings dance, no `xattr` command.

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
brew style /path/to/homebrew-gamut/Casks/gamut.rb
brew audit --cask --online /path/to/homebrew-gamut/Casks/gamut.rb
```

## Notes

- **Ad-hoc signing is required on Apple Silicon** — Tauri does this automatically
  during `tauri build`, so it's already covered. The cask intentionally does not
  set `quarantine`.
- **Auto-update (#1)** and a double-click-friendly notarized `.dmg` still require
  Developer ID signing + notarization (Option B in #3). The cask path does not
  block that — it's an independent, lower-cost first step.
