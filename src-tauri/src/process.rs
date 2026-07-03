//! Spawning console subprocesses (`git`, `ssh`) from the GUI process.
//!
//! A Tauri GUI app has no console attached to it. On Windows, spawning a console
//! subprocess without `CREATE_NO_WINDOW` makes the OS allocate a fresh console
//! window for it, which flashes on screen — once per background auto-fetch, per
//! manual fetch/pull/push, and per SSH-alias probe. The [`NoWindow`] trait
//! suppresses that window; it's a no-op on macOS/Linux, which have no such flag.

/// `CREATE_NO_WINDOW` process-creation flag: run the child without allocating a
/// console. See <https://learn.microsoft.com/windows/win32/procthread/process-creation-flags>.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Suppress the console window Windows would otherwise allocate for a spawned
/// console subprocess. Call it anywhere in a `Command` builder chain, before the
/// terminal `.output()`/`.spawn()`/`.status()`. No-op on non-Windows platforms.
pub trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindow for std::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl NoWindow for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}
