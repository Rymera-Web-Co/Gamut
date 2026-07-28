# Updates

Gamut updates itself in place, so you never have to track down and install a new
`.dmg` by hand. On launch it checks for a newer release, and if one is found, offers
to download it, install it, and relaunch the app for you.
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
  control (Stable / Nightly), and a **Check for updates** button so you can check
  for a new version any time you like.

The banner is dismissible (except mid-download); the check still surfaces again
on the next launch.

## How it works

1. The app checks an **update manifest** — a small file (`latest.json`) attached
   to the GitHub Release — that lists the latest version, its release notes, and
   a download link plus a signature for each supported operating system.
2. If that version is newer than the one you're running, Gamut offers you the
   update.
3. When you install it, Gamut checks the downloaded file's signature against a
   public key built into the app (`tauri.conf.json`, under
   `plugins.updater.pubkey`) — proof the file really came from Gamut's own
   release process and hasn't been altered. A file that doesn't match the key is
   rejected instead of installed, so a tampered or spoofed update can't get in.
4. The app then restarts itself into the new build, via `tauri-plugin-process`.

This update check only runs in the packaged desktop app. If you're running Gamut
through `pnpm dev` (the plain development server, without the Tauri runtime), the
check is simply a no-op.

## Update channels

Gamut has two update channels, switchable in **Settings → About** under
**Update channel**:

- **Stable** (default) — tracks the normal releases. This is what you want
  unless you have a reason not to.
- **Nightly** — tracks the latest automated build. Opt in only if you want
  bleeding-edge changes and are willing to put up with rough edges (see the
  caveat below).

Switching the channel changes which manifest the updater checks against. The
front-end update library (`@tauri-apps/plugin-updater`'s `check()`) can't switch
endpoints on its own, so the selection is handled in the app's Rust backend
instead: it reads the saved `pref.updateChannel` setting and picks the matching
`latest.json` address before checking.

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
- On macOS they are **unsigned**, so macOS's Gatekeeper protection will warn you
  the first time you open one — the same situation as the stable builds today
  (see [the README](../../README.md) for the one-time `xattr` workaround).

If you just want a working build, stay on **Stable**.

## Signing keys

Update packages are signed with a minisign keypair (a lightweight public/private
key pair used just for signing files), separate from OS code signing:

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

## Prerelease caveat (maintainers)

The stable-channel updater endpoint points at:

```
https://github.com/Rymera-Web-Co/Gamut/releases/latest/download/latest.json
```

GitHub's `releases/latest` resolves to the latest **non-prerelease** release, so
this URL only works while releases are published with `prerelease: false` — as
the current `v*` releases are, which is why stable-channel auto-update flows
today. A release published as a prerelease (as the early `alpha-*` tags were,
via `release.yml`) would make this URL 404 and **no update would be offered**,
even with signed artifacts attached.

Keep cutting stable releases as non-prereleases; anything experimental belongs
on the **nightly** channel instead, which is unaffected either way because it
polls a manifest pinned to the fixed `nightly` tag rather than
`releases/latest` — see [Update channels](#update-channels) above.
