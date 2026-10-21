//! Keeping the AppImage's private environment out of user shells (Linux only).
//!
//! The AppImage runtime and its `AppRun` launcher point a long list of
//! variables into the image's mount (`$APPDIR`, e.g. `/tmp/.mount_gamutXXXX`):
//! `PATH`, `XDG_DATA_DIRS`, `PYTHONHOME`/`PYTHONPATH`, `PERLLIB`, the GTK/GIO/
//! GStreamer module paths, … Gamut itself adds a few launch tweaks on top (see
//! `linux_webkit_workarounds` in `main.rs`). All of that is for the app's own
//! process. Inherited by an integrated terminal it breaks the user's tools: a
//! host `python3` with `PYTHONHOME` aimed at the image can't import `encodings`
//! and aborts, which in turn breaks `node-gyp` and every native npm build.
//!
//! [`scrub`] strips it from a spawned shell's environment. It only acts when
//! `APPDIR` is set, so native installs are left untouched.

use portable_pty::CommandBuilder;

/// Set by `main.rs` once it has re-exec'd with the host `libwayland-client`
/// preloaded. Its value is the preloaded library path, so the shell's
/// `LD_PRELOAD` can drop exactly that entry and keep anything the user set.
pub const REEXEC_GUARD: &str = "GAMUT_WAYLAND_PRELOAD_DONE";

/// Comma-separated names of the variables `main.rs` set because they were
/// unset at launch (the WebKit renderer flags). Variables the user set
/// themselves are not listed, so they survive the scrub.
pub const SET_VARS_MARKER: &str = "GAMUT_APPIMAGE_SET_VARS";

/// AppImage runtime metadata. Meaningless outside the app's own process, and a
/// stray `APPDIR`/`APPIMAGE` can make other AppImage-aware tools misbehave.
const RUNTIME_VARS: &[&str] = &["APPDIR", "APPIMAGE", "ARGV0", "OWD"];

/// Remove the AppImage's and Gamut's launch-time variables from `cmd`'s
/// environment. No-op when not running from an AppImage.
pub fn scrub(cmd: &mut CommandBuilder) {
    let env: Vec<(String, String)> = cmd
        .iter_full_env_as_str()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    for (key, value) in edits(&env) {
        match value {
            Some(v) => cmd.env(key, v),
            None => cmd.env_remove(key),
        }
    }
}

/// The changes [`scrub`] makes, as `(name, Some(new value) | None to remove)`.
/// Pure so it can be tested without touching the process environment.
fn edits(env: &[(String, String)]) -> Vec<(String, Option<String>)> {
    let get = |name: &str| env.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
    let Some(appdir) = get("APPDIR")
        .map(|d| d.trim_end_matches('/'))
        .filter(|d| is_safe_appdir(d))
    else {
        return Vec::new();
    };

    let set_by_gamut: Vec<&str> = get(SET_VARS_MARKER)
        .map(|v| v.split(',').filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let preloaded = get(REEXEC_GUARD).filter(|v| v.starts_with('/'));

    let mut out = Vec::new();
    for (key, value) in env {
        let key = key.as_str();
        if RUNTIME_VARS.contains(&key)
            || key == SET_VARS_MARKER
            || key == REEXEC_GUARD
            || set_by_gamut.contains(&key)
        {
            out.push((key.to_string(), None));
            continue;
        }

        let mut entries: Vec<&str> = value.split(':').collect();
        let before = entries.len();
        entries.retain(|e| !is_under(e, appdir));
        if key == "LD_PRELOAD" {
            if let Some(lib) = preloaded {
                if let Some(i) = entries.iter().position(|e| *e == lib) {
                    entries.remove(i);
                }
            }
        }
        if entries.len() == before {
            continue;
        }
        // Only empty entries left (e.g. `PYTHONPATH=<appdir>/…:` had a trailing
        // separator): the variable was purely the image's, so drop it.
        if entries.iter().all(|e| e.is_empty()) {
            out.push((key.to_string(), None));
        } else {
            out.push((key.to_string(), Some(entries.join(":"))));
        }
    }
    out
}

/// Guard against a bogus `APPDIR` (empty, relative, or `/`) that would match
/// every absolute path and wipe the user's `PATH`.
fn is_safe_appdir(dir: &str) -> bool {
    dir.starts_with('/') && !dir.trim_matches('/').is_empty()
}

/// Whether path-list entry `entry` is `dir` itself or lies inside it. Checked
/// on a component boundary so `/tmp/.mount_ab` doesn't match `/tmp/.mount_abc`.
fn is_under(entry: &str, dir: &str) -> bool {
    entry
        .strip_prefix(dir)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    const APPDIR: &str = "/tmp/.mount_gamutABC";

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn edit<'a>(edits: &'a [(String, Option<String>)], key: &str) -> Option<&'a Option<String>> {
        edits.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    #[test]
    fn no_op_outside_an_appimage() {
        let e = env(&[("PATH", "/usr/bin"), ("PYTHONHOME", "/opt/py")]);
        assert!(edits(&e).is_empty());
    }

    #[test]
    fn no_op_for_a_root_or_relative_appdir() {
        for dir in ["/", "", "relative/dir"] {
            let e = env(&[("APPDIR", dir), ("PATH", "/usr/bin:/bin")]);
            assert!(edits(&e).is_empty(), "APPDIR={dir:?}");
        }
    }

    #[test]
    fn removes_variables_that_only_point_into_the_image() {
        let e = env(&[
            ("APPDIR", APPDIR),
            ("PYTHONHOME", "/tmp/.mount_gamutABC/usr/"),
            ("PYTHONPATH", "/tmp/.mount_gamutABC/usr/share/pyshared/:"),
            ("GTK_EXE_PREFIX", "/tmp/.mount_gamutABC//usr"),
        ]);
        let ed = edits(&e);
        assert_eq!(edit(&ed, "PYTHONHOME"), Some(&None));
        assert_eq!(edit(&ed, "PYTHONPATH"), Some(&None));
        assert_eq!(edit(&ed, "GTK_EXE_PREFIX"), Some(&None));
        assert_eq!(edit(&ed, "APPDIR"), Some(&None));
    }

    #[test]
    fn keeps_the_users_entries_in_path_lists() {
        let e = env(&[
            ("APPDIR", APPDIR),
            (
                "PATH",
                "/home/u/.cargo/bin:/tmp/.mount_gamutABC/usr/bin/:/usr/bin",
            ),
            (
                "XDG_DATA_DIRS",
                "/tmp/.mount_gamutABC/usr/share/:/usr/share:",
            ),
        ]);
        let ed = edits(&e);
        assert_eq!(
            edit(&ed, "PATH"),
            Some(&Some("/home/u/.cargo/bin:/usr/bin".to_string()))
        );
        assert_eq!(
            edit(&ed, "XDG_DATA_DIRS"),
            Some(&Some("/usr/share:".to_string()))
        );
    }

    #[test]
    fn matches_appdir_on_a_path_boundary() {
        let e = env(&[
            ("APPDIR", APPDIR),
            ("PATH", "/tmp/.mount_gamutABCD/bin:/usr/bin"),
        ]);
        assert!(edit(&edits(&e), "PATH").is_none());
    }

    #[test]
    fn leaves_untouched_variables_alone() {
        let e = env(&[
            ("APPDIR", APPDIR),
            ("HOME", "/home/u"),
            ("PYTHONPATH", "/home/u/lib"),
        ]);
        let ed = edits(&e);
        assert!(edit(&ed, "HOME").is_none());
        assert!(edit(&ed, "PYTHONPATH").is_none());
    }

    #[test]
    fn undoes_gamuts_own_launch_tweaks_only() {
        let e = env(&[
            ("APPDIR", APPDIR),
            (SET_VARS_MARKER, "WEBKIT_DISABLE_DMABUF_RENDERER"),
            ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
            // Set by the user before launch, so not in the marker: keep it.
            ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
            (REEXEC_GUARD, "/usr/lib/libwayland-client.so.0"),
            (
                "LD_PRELOAD",
                "/usr/lib/libwayland-client.so.0:/home/u/libmine.so",
            ),
        ]);
        let ed = edits(&e);
        assert_eq!(edit(&ed, "WEBKIT_DISABLE_DMABUF_RENDERER"), Some(&None));
        assert!(edit(&ed, "WEBKIT_DISABLE_COMPOSITING_MODE").is_none());
        assert_eq!(edit(&ed, SET_VARS_MARKER), Some(&None));
        assert_eq!(edit(&ed, REEXEC_GUARD), Some(&None));
        assert_eq!(
            edit(&ed, "LD_PRELOAD"),
            Some(&Some("/home/u/libmine.so".to_string()))
        );
    }

    #[test]
    fn drops_ld_preload_when_only_the_wayland_preload_remains() {
        let e = env(&[
            ("APPDIR", APPDIR),
            (REEXEC_GUARD, "/usr/lib64/libwayland-client.so.0"),
            ("LD_PRELOAD", "/usr/lib64/libwayland-client.so.0"),
        ]);
        assert_eq!(edit(&edits(&e), "LD_PRELOAD"), Some(&None));
    }
}
