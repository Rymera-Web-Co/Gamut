//! Standalone probe for the Claude Code IDE server, for a live handshake check
//! against a real `claude` without launching the GUI.
//!
//! Run it, then in another shell point `claude` at the printed port:
//!
//! ```sh
//! cargo run --example ide_probe
//! # →  IDE server on port 54321  (lockfile ~/.claude/ide/54321.lock)
//!
//! # in another terminal:
//! CLAUDE_CODE_SSE_PORT=54321 ENABLE_IDE_INTEGRATION=true claude
//! #   then inside claude:  /ide      → should list "Gamut" and connect
//! ```
//!
//! Every few seconds it pushes a dummy selection, so once connected you should
//! see the selection context update inside `claude`.

use gamut_lib::claude_ide::{start_server, IdeConfig, Selection};

fn main() {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let handle = start_server(IdeConfig {
        workspace_folders: vec![cwd.clone()],
        lockfile_dir: None, // real ~/.claude/ide so `claude` discovers it
    })
    .expect("bind IDE server");

    let port = handle.port();
    println!("IDE server on port {port}  (lockfile in ~/.claude/ide/{port}.lock)");
    println!("Run:  CLAUDE_CODE_SSE_PORT={port} ENABLE_IDE_INTEGRATION=true claude");
    println!("Then inside claude:  /ide   (should list \"Gamut\")\n");

    let mut n = 0u32;
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3));
        n += 1;
        handle.push_selection(Selection {
            text: format!("// probe selection #{n}"),
            file_path: format!("{cwd}/README.md"),
            start_line: n,
            start_char: 0,
            end_line: n,
            end_char: 20,
            is_empty: false,
        });
        println!(
            "pushed selection #{n}  ({} client(s) connected)",
            handle.client_count()
        );
    }
}
