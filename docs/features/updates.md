# Updates

Gamut updates itself in place. On launch it checks for a newer release; when one
is found it offers to download, install, and relaunch — no manual `.dmg` hunting.
Built on [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/).

## What you see

- **On launch** — Gamut quietly checks for an update. If you're up to date or
  offline, nothing appears.
- **Update available** — a slim bar drops in at the top of the window:
  *"A new version of Gamut (x.y.z) is available."* with **Download & install**.
- **Downloading** — the bar shows live progress.
- **Ready** — once installed: *"Update installed — restart Gamut to finish."*
  with **Restart now**. The relaunch boots straight into the new version.
- **Settings → About** — shows the current version, an **Update channel**
  control (Stable / Nightly), and a **Check for updates** button for an
  on-demand check at any time.

The banner is dismissible (except mid-download); the check still surfaces again
on the next launch.

## How it works

1. The app polls an **update manifest** — a `latest.json` attached to the
   GitHub Release — listing the latest version, notes, and a per-platform
   download URL + signature.
2. If the manifest version is newer than the running version, the update is
   offered.
3. On install, Tauri **verifies the package signature** against the public key
   baked into `tauri.conf.json` (`plugins.updater.pubkey`). A package that
   doesn't match the key is rejected, so a tampered or spoofed update can't be
   installed.
4. `tauri-plugin-process` relaunches the app into the new build.

The updater is only active in the **bundled desktop app**. Under `pnpm dev`
(plain Vite, no Tauri runtime) the check is a no-op.

## Update channels

Gamut has two update channels, switchable in **Settings → About** under
**Update channel**:

- **Stable** (default) — tracks the normal releases. This is what you want
  unless you have a reason not to.
- **Nightly** — tracks the latest automated build. Opt in only if you want
  bleeding-edge changes and are willing to put up with rough edges (see the
  caveat below).

Switching the channel changes which manifest the updater polls. Because the JS
`@tauri-apps/plugin-updater` `check()` has no runtime endpoint override, the
selection happens in **Rust**: the update check reads the `pref.updateChannel`
setting and picks the matching `latest.json` endpoint before checking.

### How nightlies are delivered

Nightly builds run on a schedule (10pm Australia/Brisbane) for all four targets
— macOS arm64/x64, Linux x64, Windows x64 — and are published as a **rolling
GitHub prerelease** under a fixed `nightly` tag that is recreated on each run.
The nightly updater polls a manifest pinned to that tag:

```
https://github.com/Rymera-Web-Co/Gamut/releases/download/nightly/latest.json
```

This URL works for a **prerelease** because it references the tag directly,
sidestepping the `releases/latest` 404 caveat below — `releases/latest` only
resolves to non-prerelease releases, but `releases/download/<tag>/…` resolves to
whatever the `nightly` tag currently points at. Each scheduled run overwrites
that tag's assets (including `latest.json`), so installs on the nightly channel
always see the most recent build.

Nightly packages are signed with the **same minisign keypair** as stable builds,
so the existing public key in `tauri.conf.json` (`plugins.updater.pubkey`)
verifies them too — no new signing secrets are involved.

### ⚠️ Nightly caveats

- Nightlies are **unstable** by design — they ship unreleased work and may break.
- On macOS they are **unsigned**, so Gatekeeper will warn on first launch — the
  same situation as the stable alpha builds today (see [the
  README](../../README.md) for the one-time `xattr` workaround).

If you just want a working build, stay on **Stable**.

## Signing keys

Update packages are signed with a minisign keypair, separate from OS code
signing:

- **Public key** lives in `tauri.conf.json` under `plugins.updater.pubkey` and
  is safe to commit.
- **Private key + password** are **secrets** — never committed. They're consumed
  in CI as the `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets (see
  `.github/workflows/release.yml`).

To (re)generate a keypair:

```sh
pnpm tauri signer generate -w ~/.gamut/updater.key
```

Then put the public key in `tauri.conf.json` and add the private key (file
contents) + password as the two CI secrets above. **If the private key or
password is lost, you can't sign updates** and existing installs won't be able
to update until they're reinstalled with a new key.

## Releasing an update

`createUpdaterArtifacts` is enabled in `tauri.conf.json`, so each release build
emits the signed update package (e.g. `*.app.tar.gz` + `*.app.tar.gz.sig` on
macOS) alongside the `.dmg`. On a tag push, `tauri-action` signs those artifacts
and uploads them — plus a generated `latest.json` — to the GitHub Release. No
extra step is needed beyond pushing a release tag.

## ⚠️ Prerelease caveat

The updater endpoint points at:

```
https://github.com/Rymera-Web-Co/Gamut/releases/latest/download/latest.json
```

GitHub's `releases/latest` resolves to the latest **non-prerelease** release.
While every release is published as a prerelease (the current `alpha-*` tags set
`prerelease: true` in `release.yml`), this URL returns 404 and **no update will
be offered** — even though the signed artifacts exist on the prerelease.

For auto-update to actually flow, either:

- cut a stable, non-prerelease release (e.g. a `v*` tag with `prerelease: false`), or
- serve `latest.json` from an endpoint that includes prereleases (a static file
  or a small proxy that reads the GitHub API).

Until then the plumbing is in place and verified, but the alpha builds won't
self-update.

Note this caveat applies to the **stable** channel. The **nightly** channel is
unaffected because it polls a manifest pinned to the fixed `nightly` tag rather
than `releases/latest` — see [Update channels](#update-channels) above.
