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
- **Settings → About** — shows the current version and a **Check for updates**
  button for an on-demand check at any time.

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
