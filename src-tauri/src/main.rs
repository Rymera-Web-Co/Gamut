// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    linux_webkit_workarounds::apply();

    gamut_lib::run()
}

/// Workarounds for WebKitGTK crashes caused by an AppImage's bundled graphics
/// stack clashing with a newer host. AppImage-only (gated on `APPIMAGE`/`APPDIR`
/// in `apply()`); native installs use the host stack and skip all of it.
///
/// Two crashes are handled:
///   1. DMABUF/compositing renderer aborts `WebKitWebProcess` (white window,
///      SIGABRT) — fixed by disabling those renderers via env vars.
///   2. `EGL_BAD_PARAMETER` from the bundled `libwayland-client` shadowing the
///      host's (Mesa's `libEGL` inits Wayland even on X11) — fixed by preloading
///      the host lib and re-executing so the linker picks it up first.
///
/// See: https://github.com/tauri-apps/tauri/issues/11988
#[cfg(target_os = "linux")]
mod linux_webkit_workarounds {
    use std::env;
    use std::os::unix::process::CommandExt;
    use std::path::Path;
    use std::process::Command;

    /// Set after we re-exec, so the second launch doesn't loop forever.
    const REEXEC_GUARD: &str = "GAMUT_WAYLAND_PRELOAD_DONE";

    pub fn apply() {
        // AppImage-only. `APPIMAGE` is set by the AppImage runtime; an extracted
        // image run via `AppRun` sets only `APPDIR`, so check both. Absence of
        // both means a native install: it uses the host stack and must NOT disable
        // compositing, which removes the webview frame clock and makes the
        // terminal GPU renderer draw one frame behind.
        if env::var_os("APPIMAGE").is_none() && env::var_os("APPDIR").is_none() {
            return;
        }

        // Both flags are the known-safe AppImage config (costs the GPU terminal
        // renderer, which defaults OFF here). WebKitGTK reads them lazily when the
        // webview is created, so setting them before the Tauri builder runs works.
        set_if_unset("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        set_if_unset("WEBKIT_DISABLE_COMPOSITING_MODE", "1");

        // Preload the host `libwayland-client` (see crash 2 above), then re-exec.
        // Don't loop: if we've already re-exec'd, the preload is in effect.
        if env::var_os(REEXEC_GUARD).is_some() {
            return;
        }

        let Some(host_lib) = find_system_libwayland_client() else {
            // No host library found; nothing to preload.
            return;
        };

        // If LD_PRELOAD already references a libwayland-client, respect it.
        if env::var("LD_PRELOAD")
            .map(|v| v.contains("libwayland-client"))
            .unwrap_or(false)
        {
            return;
        }

        let ld_preload = match env::var("LD_PRELOAD") {
            Ok(existing) if !existing.is_empty() => format!("{host_lib}:{existing}"),
            _ => host_lib,
        };

        let exe = match env::current_exe() {
            Ok(p) => p,
            Err(_) => return,
        };

        let err = Command::new(exe)
            .args(env::args_os().skip(1))
            .env("LD_PRELOAD", ld_preload)
            .env(REEXEC_GUARD, "1")
            .exec();

        // `exec` only returns on failure; fall through and let the app try to
        // start normally rather than refusing to launch.
        eprintln!("gamut: failed to re-exec with libwayland-client preload: {err}");
    }

    /// Locate the host's `libwayland-client.so.0`, preferring the path that
    /// matches the running architecture. Returns `None` if none exist.
    fn find_system_libwayland_client() -> Option<String> {
        // The multiarch (Debian/Ubuntu) directory for the current arch.
        let multiarch = match env::consts::ARCH {
            "x86_64" => Some("x86_64-linux-gnu"),
            "aarch64" => Some("aarch64-linux-gnu"),
            "arm" => Some("arm-linux-gnueabihf"),
            _ => None,
        };

        let mut candidates: Vec<String> = Vec::new();
        // Fedora/RHEL/openSUSE.
        candidates.push("/usr/lib64/libwayland-client.so.0".into());
        // Debian/Ubuntu multiarch.
        if let Some(triple) = multiarch {
            candidates.push(format!("/usr/lib/{triple}/libwayland-client.so.0"));
        }
        // Arch and other single-lib-dir distros.
        candidates.push("/usr/lib/libwayland-client.so.0".into());

        candidates.into_iter().find(|p| Path::new(p).exists())
    }

    fn set_if_unset(key: &str, value: &str) {
        if env::var_os(key).is_none() {
            env::set_var(key, value);
        }
    }
}
