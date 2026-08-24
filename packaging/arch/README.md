# Arch Linux packaging

Gamut ships a pacman package for Arch and Arch-based distros (CachyOS, EndeavourOS,
Manjaro). Every `v*` / `alpha-*` release carries a `gamut-bin-<version>-1-x86_64.pkg.tar.zst`
asset, built by the `arch-package` job in
[`.github/workflows/release.yml`](../../.github/workflows/release.yml).

## Install

From a release asset:

```bash
sudo pacman -U ./gamut-bin-<version>-1-x86_64.pkg.tar.zst
```

Or build it yourself from this directory:

```bash
cd packaging/arch
makepkg -si          # downloads the released .deb, repackages it, installs it
```

> **The committed `pkgver` and hash pin one release.** `makepkg` here builds the
> version this file was last pinned to — it does not follow the newest release. To
> build a newer one, bump it first (see [Bumping the version](#bumping-the-version)),
> or just download the asset CI built for that release.

## Why an Arch package and not the AppImage

The AppImage is built on `ubuntu-22.04` and **bundles** a graphics/Wayland
userspace about three years old. On a system with recent Mesa and a new GPU,
WebKitGTK initializes EGL/GBM through those stale bundled libraries and aborts —
a white window, then `SIGABRT`.

Neither the `.deb` nor this pacman package bundles those libraries: WebKitGTK
loads EGL, GL and Wayland from the host at runtime. So that crash class does not
apply, and the GPU terminal renderer works with no WebKit workaround environment
variables (the app only sets those when it detects an AppImage run).

## The two PKGBUILDs

| File | Package | What it does | When to use it |
|---|---|---|---|
| `PKGBUILD` | `gamut-bin` | Downloads the release `.deb` and extracts its payload into `$pkgdir`. Seconds, no toolchain. | Default. This is what CI publishes. |
| `PKGBUILD.src` | `gamut` | Builds from the release source tarball with `pnpm` + `cargo`. Minutes, needs Rust and Node. | A WebKitGTK soname bump, an architecture the release does not publish (for example `aarch64`), or a source build on principle. |

Only one of them can be named `PKGBUILD` at a time, so build the fallback with
`makepkg -p PKGBUILD.src`.

The two variants are not byte-identical installs. `gamut-bin` extracts the `.deb`,
so it ships that bundle's `Gamut.desktop` (with `Exec=/usr/bin/gamut` and a
`TryExec` line) and its 32/128/256 px icons. `gamut` installs the static
`gamut.desktop` from this directory (`Exec=gamut`) and the five icon sizes from
`src-tauri/icons`. Both put a working entry with a working icon in the menu.

Both declare `webkit2gtk-4.1`, `gtk3`, `alsa-lib` and `hicolor-icon-theme` as
runtime dependencies. `alsa-lib` is not in the `.deb`'s own `Depends:` field, but
the binary links `libasound.so.2`, so it must be declared here — otherwise the app
fails to start on a system that does not already have ALSA installed. `gamut-bin` `provides` and `conflicts` with `gamut`, so the two
variants never install together.

### What `gamut-bin` changes in the repackaged files

Everything is extracted verbatim — the `.deb` already installs `/usr/bin/gamut`,
the desktop entry and the hicolor icons in the paths Arch expects — apart from two
fixes:

1. **`Categories=`.** The `.deb` ships it empty, because `tauri.conf.json` sets no
   `bundle.category`, and an empty `Categories` keeps the entry out of the
   application menu. `package()` rewrites it to `Development;RevisionControl;`,
   and fails the build if the line ever stops being generated rather than
   no-opping silently. The root fix is a `bundle.category` in `tauri.conf.json`,
   which would also fix the `.deb`, `.rpm` and AppImage entries — it changes the
   macOS bundle metadata too, so it is tracked separately from this packaging work.
2. **The `256x256@2` icon directory.** The hicolor spec has no such size (the
   HiDPI suffix is `@2x`), so that icon is never loaded. The file is 256×256, so
   `package()` moves it to `256x256`.

### Caveats of `gamut-bin`

- **Soname coupling.** The pinned binary needs `libwebkit2gtk-4.1.so.0`. If
  upstream moves Gamut to the GTK4 WebKit build (`webkitgtk-6.0`) or the soname
  bumps, the binary stops loading and you need `PKGBUILD.src` instead.
- **`x86_64` only.** The release publishes only an `amd64` `.deb`, so this variant
  declares `arch=('x86_64')`. Use `PKGBUILD.src` on `aarch64`.
- **glibc floor.** The release binary is built against glibc 2.34 and runs on
  Arch's newer glibc (forward compatible), not the other way around.

## Bumping the version

The committed `sha256sums` pin one specific release, so a version bump always
re-pins them:

1. Edit `pkgver` (and `_tag`, if the release tag is not `v$pkgver` — `alpha-*`
   releases are tagged independently of the app version).
2. `updpkgsums` — downloads the sources and rewrites `sha256sums`. Needs
   `pacman-contrib`.
3. `makepkg -f` — confirms it still builds.
4. `makepkg --printsrcinfo > .SRCINFO` — only needed if you publish to the AUR;
   the release asset does not use `.SRCINFO`.

## How CI publishes it

The `arch-package` job runs on tag pushes only, in an `archlinux:latest` container
(GitHub has no Arch runner). It:

1. waits for the `build` job, so the `.deb` is already attached to the release;
2. reads the app version from `src-tauri/tauri.conf.json` and rewrites `pkgver`
   and `_tag` in a copy of `PKGBUILD`;
3. runs `updpkgsums` to re-pin the hash to the `.deb` of *this* release, then
   `makepkg` as a non-root user (`makepkg` refuses to run as root);
4. uploads `gamut-bin-*.pkg.tar.zst` to the same release.

The job declares `needs: build` but gates on `!cancelled()` rather than on the
`build` job succeeding, so a failure in an unrelated leg (macOS notarization, for
example) cannot silently drop the Arch asset from an otherwise complete release.
If the Linux leg itself failed, there is no `.deb` to repackage and this job fails
loudly on the download — re-run the workflow's failed jobs.

### What this job does not verify

`updpkgsums` re-pins `sha256sums` to whatever the release URL serves, then
`makepkg` checks the download against that fresh hash — so the committed hash is
not an integrity check inside CI, and the pipeline does not independently verify
the `.deb` it repackages. This is a deliberate trade-off, not an oversight:
anyone able to replace a release asset can already replace the `.deb` that
Debian/Ubuntu users install directly, so the pacman asset adds no new exposure.
Closing it properly means verifying the `.deb` against the minisign `.sig` the
release already carries, or passing the hash from the `build` job — worth doing if
the release pipeline ever gains asset verification generally.

The container is `archlinux:latest`, deliberately unpinned. Arch is a rolling
distribution and `pacman -Syu` installs from the current repositories, so pinning
an older image digest invites partial-upgrade breakage rather than preventing it.

## AUR

Gamut is not in the AUR yet. Publishing there is the idiomatic Arch channel and
would mirror how the Homebrew cask is published — pushed from a maintainer
machine, not from CI (see [`homebrew/README.md`](../../homebrew/README.md)). The
release asset covers direct download in the meantime.
