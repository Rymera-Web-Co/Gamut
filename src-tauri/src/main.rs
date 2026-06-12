// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    linux_webkit_workarounds::apply();

    gamut_lib::run()
}

/// Workarounds for WebKitGTK rendering failures on Linux, primarily affecting
/// AppImage builds run on a different (usually newer) distro than they were
/// built on.
///
/// Two failure modes are handled:
///   1. The DMABUF/compositing renderer aborting `WebKitWebProcess` on some
///      Mesa/GPU stacks (white window, then SIGABRT).
///   2. `Could not create default EGL display: EGL_BAD_PARAMETER` on Wayland,
///      caused by the AppImage's bundled `libwayland-client` shadowing the
///      host's. Mesa's `libEGL` then loads stale Wayland symbols and aborts.
///
/// (1) is fixed by disabling those renderers via env vars. (2) is fixed by
/// preloading the host's `libwayland-client` and re-executing ourselves so the
/// dynamic linker picks it up before any Wayland/EGL code runs.
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
        // Always disable the renderers that abort on incompatible GPU stacks.
        // WebKitGTK reads these lazily when the webview is created, so setting
        // them here (before the Tauri builder runs) is sufficient.
        set_if_unset("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        set_if_unset("WEBKIT_DISABLE_COMPOSITING_MODE", "1");

        // The EGL_BAD_PARAMETER crash only happens under Wayland.
        if !is_wayland() {
            return;
        }

        // Don't loop: if we've already re-exec'd, the preload is in effect.
        if env::var_os(REEXEC_GUARD).is_some() {
            return;
        }

        let Some(host_lib) = find_system_libwayland_client() else {
            // No host library found (or not an AppImage); nothing to preload.
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

    fn is_wayland() -> bool {
        env::var("XDG_SESSION_TYPE")
            .map(|t| t.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false)
            || env::var_os("WAYLAND_DISPLAY").is_some()
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
