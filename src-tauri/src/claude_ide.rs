//! Editor side of Claude Code's IDE integration.
//!
//! A `claude` CLI launched in an integrated terminal auto-connects to an editor
//! over a loopback WebSocket and receives the current editor selection as
//! ambient context — the same mechanism the VS Code and Neovim integrations use.
//! This module implements that editor side:
//!
//! 1. Bind a loopback WebSocket server on a random port.
//! 2. Publish a lockfile at `~/.claude/ide/<port>.lock` (respecting
//!    `CLAUDE_CONFIG_DIR`) holding `{pid, workspaceFolders, ideName, transport,
//!    authToken}`. The CLI reads it to learn the auth token.
//! 3. Terminals launched by the app export `CLAUDE_CODE_SSE_PORT=<port>` and
//!    `ENABLE_IDE_INTEGRATION=true`, so the CLI knows which port to dial (env
//!    injection lives in `commands::terminal`).
//! 4. On connect, the CLI presents `x-claude-code-ide-authorization: <token>`;
//!    the server rejects a missing/mismatched token with HTTP 401 (this header
//!    check is the fix for CVE-2025-52882).
//! 5. Over the socket, JSON-RPC 2.0 / MCP: the server answers `initialize` and
//!    `tools/list`, handles a few `tools/call`s (`getCurrentSelection`,
//!    `getLatestSelection`, `getWorkspaceFolders`), and pushes a
//!    `selection_changed` notification whenever the editor selection moves.
//!
//! The transport is loopback-only and the token is readable from the 0600
//! lockfile, so the socket itself is plaintext (matching the reference
//! implementations). The threaded, blocking design mirrors `control.rs` rather
//! than pulling in an async runtime.
//!
//! NOTE: Claude Code's IDE protocol is not a published contract — the shapes
//! here follow the open-source `coder/claudecode.nvim` reimplementation and the
//! observable behaviour of the official extensions, and may need to track
//! upstream changes.

use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tungstenite::http::StatusCode;
use tungstenite::Message;

/// HTTP header the CLI sends carrying the token from the lockfile. Validated on
/// the WebSocket upgrade; a mismatch is rejected 401 (CVE-2025-52882).
const AUTH_HEADER: &str = "x-claude-code-ide-authorization";
/// How the editor names itself to the CLI (shown in `/ide`).
const IDE_NAME: &str = "Gamut";
/// Poll cadence for the per-connection loop: how long a blocking read waits
/// before yielding to flush any queued outbound notifications. Bounds selection
/// delivery latency; small enough to feel instant, large enough to stay idle.
const POLL: Duration = Duration::from_millis(100);

/// The editor selection the app pushes to connected CLIs. Field names are
/// snake_case on the Tauri IPC boundary; they're reshaped into the protocol's
/// camelCase `selection_changed` params before going on the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Selection {
    /// The selected text (may be empty for a bare caret).
    pub text: String,
    /// Absolute path of the file the selection is in.
    pub file_path: String,
    /// Zero-based start line / character.
    pub start_line: u32,
    pub start_char: u32,
    /// Zero-based end line / character.
    pub end_line: u32,
    pub end_char: u32,
    /// True when nothing is highlighted (caret only).
    pub is_empty: bool,
}

impl Selection {
    /// The protocol's `selection_changed` params (camelCase, LSP-style range).
    fn to_params(&self) -> Value {
        json!({
            "text": self.text,
            "filePath": self.file_path,
            "fileUrl": format!("file://{}", self.file_path),
            "selection": {
                "start": { "line": self.start_line, "character": self.start_char },
                "end": { "line": self.end_line, "character": self.end_char },
                "isEmpty": self.is_empty,
            }
        })
    }
}

/// Config for starting the server. `lockfile_dir` overrides where the `.lock`
/// file is written (defaults to `$CLAUDE_CONFIG_DIR`/`~/.claude` + `/ide`); the
/// override exists so tests can point at a temp dir instead of the real one.
#[derive(Debug, Clone, Default)]
pub struct IdeConfig {
    pub workspace_folders: Vec<String>,
    pub lockfile_dir: Option<PathBuf>,
}

/// State shared between the accept thread, the per-connection threads, and the
/// app (via [`IdeHandle`]).
struct Shared {
    token: String,
    /// Per-connection outbound queues, keyed by an opaque connection id.
    clients: Mutex<HashMap<u64, Sender<Message>>>,
    /// Most recent selection, replayed to a client right after it initializes
    /// and returned by the `getLatestSelection` tool.
    last_selection: Mutex<Option<Selection>>,
    workspace_folders: Vec<String>,
}

/// A running IDE server. Cheap to clone (all shared state is behind `Arc`).
/// Held by [`crate::state::AppState`] so terminal spawns can read the port and
/// the frontend can push selections.
#[derive(Clone)]
pub struct IdeHandle {
    port: u16,
    lockfile: PathBuf,
    shared: Arc<Shared>,
}

impl IdeHandle {
    /// The port terminals should advertise via `CLAUDE_CODE_SSE_PORT`.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// How many `claude` clients are currently connected.
    pub fn client_count(&self) -> usize {
        self.shared.clients.lock().map(|c| c.len()).unwrap_or(0)
    }

    /// Record `sel` as the latest selection and push a `selection_changed`
    /// notification to every connected client.
    pub fn push_selection(&self, sel: Selection) {
        let note = json!({
            "jsonrpc": "2.0",
            "method": "selection_changed",
            "params": sel.to_params(),
        })
        .to_string();
        if let Ok(mut last) = self.shared.last_selection.lock() {
            *last = Some(sel);
        }
        if let Ok(clients) = self.shared.clients.lock() {
            for tx in clients.values() {
                // A full queue / dead receiver just means that connection is
                // gone; its thread will reap itself.
                let _ = tx.send(Message::Text(note.clone()));
            }
        }
    }

    /// Remove the lockfile. Called on app shutdown so a later CLI launch doesn't
    /// dial a dead port.
    pub fn cleanup(&self) {
        let _ = std::fs::remove_file(&self.lockfile);
    }
}

/// Start the IDE WebSocket server: bind a loopback port, write the lockfile, and
/// serve connections on a background thread. Returns a handle for pushing
/// selections and reading the port. Tauri-independent so it can be exercised by
/// tests directly.
pub fn start_server(cfg: IdeConfig) -> std::io::Result<IdeHandle> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();

    let token = uuid::Uuid::new_v4().to_string();
    let lockfile = write_lockfile(&cfg, port, &token)?;

    let shared = Arc::new(Shared {
        token,
        clients: Mutex::new(HashMap::new()),
        last_selection: Mutex::new(None),
        workspace_folders: cfg.workspace_folders,
    });

    let accept_shared = Arc::clone(&shared);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let s = Arc::clone(&accept_shared);
            std::thread::spawn(move || serve_conn(stream, s));
        }
    });

    Ok(IdeHandle {
        port,
        lockfile,
        shared,
    })
}

/// Directory the lockfile lives in: `$CLAUDE_CONFIG_DIR/ide`, else
/// `$HOME/.claude/ide`. Mirrors the CLI's own discovery.
fn ide_dir() -> Option<PathBuf> {
    let base = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs_home().map(|h| h.join(".claude")))?;
    Some(base.join("ide"))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Write `<port>.lock` (0600, in a 0700 dir) and return its path.
fn write_lockfile(cfg: &IdeConfig, port: u16, token: &str) -> std::io::Result<PathBuf> {
    let dir = cfg
        .lockfile_dir
        .clone()
        .or_else(ide_dir)
        .ok_or_else(|| std::io::Error::other("cannot resolve Claude config dir"))?;
    create_private_dir(&dir)?;
    let body = json!({
        "pid": std::process::id(),
        "workspaceFolders": cfg.workspace_folders,
        "ideName": IDE_NAME,
        "transport": "ws",
        "authToken": token,
    });
    let path = dir.join(format!("{port}.lock"));
    write_private(&path, serde_json::to_string(&body)?.as_bytes())?;
    Ok(path)
}

/// Handle one CLI connection: perform the authenticated WebSocket upgrade, then
/// pump JSON-RPC requests and queued outbound notifications until it closes.
// The 401 `Err` branch is a large `http::Response<Option<String>>`, but the
// callback signature is fixed by `tungstenite::accept_hdr`, so the lint is moot.
#[allow(clippy::result_large_err)]
fn serve_conn(stream: TcpStream, shared: Arc<Shared>) {
    let expected = shared.token.clone();
    let callback = |req: &tungstenite::handshake::server::Request,
                    resp: tungstenite::handshake::server::Response| {
        let ok = req
            .headers()
            .get(AUTH_HEADER)
            .and_then(|v| v.to_str().ok())
            .map(|v| v == expected)
            .unwrap_or(false);
        if ok {
            Ok(resp)
        } else {
            let err = tungstenite::http::Response::builder()
                .status(StatusCode::UNAUTHORIZED)
                .body(Some("unauthorized".to_string()))
                .expect("static 401 response builds");
            Err(err)
        }
    };

    let mut ws = match tungstenite::accept_hdr(stream, callback) {
        Ok(ws) => ws,
        Err(_) => return, // failed/‌rejected handshake
    };
    // Blocking reads yield after POLL so the loop can flush outbound messages.
    if ws.get_ref().set_read_timeout(Some(POLL)).is_err() {
        return;
    }

    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let cid = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel::<Message>();
    if let Ok(mut clients) = shared.clients.lock() {
        clients.insert(cid, tx);
    }

    let outcome = pump(&mut ws, &rx, &shared);
    // Deregister and close cleanly regardless of how the loop ended.
    if let Ok(mut clients) = shared.clients.lock() {
        clients.remove(&cid);
    }
    if outcome.is_ok() {
        let _ = ws.close(None);
    }
}

/// The per-connection read/write loop. Returns `Err` on a transport failure.
fn pump(
    ws: &mut tungstenite::WebSocket<TcpStream>,
    rx: &Receiver<Message>,
    shared: &Shared,
) -> Result<(), ()> {
    loop {
        // Flush anything queued for this client (selection notifications, or a
        // replayed selection right after initialize).
        while let Ok(msg) = rx.try_recv() {
            if ws.send(msg).is_err() {
                return Err(());
            }
        }

        match ws.read() {
            Ok(Message::Text(text)) => {
                if let Some(reply) = handle_rpc(text.as_str(), shared) {
                    if ws.send(Message::Text(reply)).is_err() {
                        return Err(());
                    }
                }
            }
            Ok(Message::Ping(p)) => {
                if ws.send(Message::Pong(p)).is_err() {
                    return Err(());
                }
            }
            Ok(Message::Close(_)) => return Ok(()),
            Ok(_) => {} // binary / pong / frame — ignore
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                // Idle read timeout — loop back to flush outbound + retry.
            }
            Err(_) => return Err(()),
        }
    }
}

/// Handle one JSON-RPC message. Returns the serialized reply for a request, or
/// `None` for a notification (which gets no response). Unknown requests get a
/// JSON-RPC "method not found"; malformed input is dropped.
fn handle_rpc(text: &str, shared: &Shared) -> Option<String> {
    let v: Value = serde_json::from_str(text).ok()?;
    let method = v.get("method").and_then(Value::as_str).unwrap_or("");
    let id = v.get("id").cloned();

    match method {
        "initialize" => {
            // Match the reference (`claudecode.nvim`) capabilities exactly:
            // `logging` as an object, and `listChanged: true` on prompts/tools so
            // the CLI enables tool discovery (a thin `{tools:{}}` may leave the
            // selection tools unregistered). Protocol pinned to the version the
            // reference hardcodes, unless the client asks for a specific one.
            let proto = v
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(Value::as_str)
                .unwrap_or("2024-11-05");
            Some(result(
                id,
                json!({
                    "protocolVersion": proto,
                    "capabilities": {
                        "logging": {},
                        "prompts": { "listChanged": true },
                        "tools": { "listChanged": true },
                    },
                    "serverInfo": { "name": "gamut", "version": env!("CARGO_PKG_VERSION") },
                }),
            ))
        }
        "notifications/initialized" => None, // ack-only notification
        "tools/list" => Some(result(id, json!({ "tools": tool_defs() }))),
        // We advertise `prompts`/`logging` capabilities to match the reference,
        // so the CLI queries these right after connect. Answer with empty lists
        // rather than a `-32601`, which during capability negotiation can make
        // the CLI treat the IDE as degraded and skip selection ingestion.
        "prompts/list" => Some(result(id, json!({ "prompts": [] }))),
        "resources/list" => Some(result(id, json!({ "resources": [] }))),
        "tools/call" => {
            let name = v
                .get("params")
                .and_then(|p| p.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            Some(result(id, call_tool(name, shared)))
        }
        _ => {
            // A request we don't implement gets an error; an unknown
            // *notification* (no id) is silently ignored.
            id.map(|id| {
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("method not found: {method}") },
                })
                .to_string()
            })
        }
    }
}

/// Build a JSON-RPC success response envelope.
fn result(id: Option<Value>, result: Value) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "result": result,
    })
    .to_string()
}

/// Declared tools. A prototype subset — enough for the CLI to see the editor as
/// selection-aware; the diff/diagnostics tools are declared as stubs to fill in.
fn tool_defs() -> Value {
    let no_args = json!({ "type": "object", "properties": {} });
    json!([
        { "name": "getCurrentSelection", "description": "The active editor selection.", "inputSchema": no_args },
        { "name": "getLatestSelection", "description": "The most recent editor selection.", "inputSchema": no_args },
        { "name": "getWorkspaceFolders", "description": "Open workspace folders.", "inputSchema": no_args },
        { "name": "getOpenEditors", "description": "Currently open editors.", "inputSchema": no_args },
    ])
}

/// Execute a `tools/call`. Results use MCP's `{content:[{type:"text",...}]}`
/// shape, with the payload JSON encoded as text.
fn call_tool(name: &str, shared: &Shared) -> Value {
    match name {
        "getCurrentSelection" | "getLatestSelection" => {
            let sel = shared.last_selection.lock().ok().and_then(|s| s.clone());
            match sel {
                Some(s) => text_content(s.to_params()),
                None => text_content(json!({ "selection": null })),
            }
        }
        "getWorkspaceFolders" => text_content(json!({ "folders": shared.workspace_folders })),
        "getOpenEditors" => text_content(json!({ "editors": [] })),
        other => json!({
            "content": [{ "type": "text", "text": format!("tool not implemented: {other}") }],
            "isError": true,
        }),
    }
}

/// Wrap a JSON value as an MCP text-content tool result.
fn text_content(payload: Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": payload.to_string() }],
        "isError": false,
    })
}

/// Create a directory restricted to the owner on unix (0700).
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Write `contents` to `path`, restricting it to the owner on unix (0600).
fn write_private(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpStream;
    use tungstenite::client::IntoClientRequest;

    fn sample_selection() -> Selection {
        Selection {
            text: "let x = 1;".into(),
            file_path: "/tmp/foo.rs".into(),
            start_line: 9,
            start_char: 0,
            end_line: 9,
            end_char: 10,
            is_empty: false,
        }
    }

    #[test]
    fn selection_to_params_is_camelcase_lsp_range() {
        let p = sample_selection().to_params();
        assert_eq!(p["filePath"], "/tmp/foo.rs");
        assert_eq!(p["fileUrl"], "file:///tmp/foo.rs");
        assert_eq!(p["selection"]["start"]["line"], 9);
        assert_eq!(p["selection"]["end"]["character"], 10);
        assert_eq!(p["selection"]["isEmpty"], false);
    }

    #[test]
    fn lockfile_has_expected_shape() {
        let dir = std::env::temp_dir().join(format!("gamut-ide-test-{}", std::process::id()));
        let cfg = IdeConfig {
            workspace_folders: vec!["/work/repo".into()],
            lockfile_dir: Some(dir.clone()),
        };
        let path = write_lockfile(&cfg, 12345, "tok-abc").unwrap();
        assert_eq!(path, dir.join("12345.lock"));
        let body: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(body["transport"], "ws");
        assert_eq!(body["ideName"], "Gamut");
        assert_eq!(body["authToken"], "tok-abc");
        assert_eq!(body["workspaceFolders"][0], "/work/repo");
        assert!(body["pid"].as_u64().unwrap() > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rpc_initialize_echoes_protocol_and_advertises_tools() {
        let shared = Shared {
            token: "t".into(),
            clients: Mutex::new(HashMap::new()),
            last_selection: Mutex::new(None),
            workspace_folders: vec![],
        };
        let req = json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-03-26" }
        })
        .to_string();
        let reply: Value = serde_json::from_str(&handle_rpc(&req, &shared).unwrap()).unwrap();
        assert_eq!(reply["id"], 1);
        assert_eq!(reply["result"]["protocolVersion"], "2025-03-26");
        // `tools.listChanged` is what makes the CLI register and use the IDE
        // tools — without it the selection is delivered but never ingested.
        assert_eq!(
            reply["result"]["capabilities"]["tools"]["listChanged"],
            true
        );
        assert_eq!(
            reply["result"]["capabilities"]["prompts"]["listChanged"],
            true
        );
        assert!(reply["result"]["capabilities"]["logging"].is_object());
    }

    #[test]
    fn rpc_prompts_list_returns_empty_not_an_error() {
        let shared = Shared {
            token: "t".into(),
            clients: Mutex::new(HashMap::new()),
            last_selection: Mutex::new(None),
            workspace_folders: vec![],
        };
        let req = json!({ "jsonrpc": "2.0", "id": 2, "method": "prompts/list" }).to_string();
        let reply: Value = serde_json::from_str(&handle_rpc(&req, &shared).unwrap()).unwrap();
        assert!(reply["result"]["prompts"].is_array());
        assert!(reply.get("error").is_none());
    }

    #[test]
    fn rpc_notification_gets_no_reply() {
        let shared = Shared {
            token: "t".into(),
            clients: Mutex::new(HashMap::new()),
            last_selection: Mutex::new(None),
            workspace_folders: vec![],
        };
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string();
        assert!(handle_rpc(&note, &shared).is_none());
    }

    #[test]
    fn unknown_method_returns_method_not_found() {
        let shared = Shared {
            token: "t".into(),
            clients: Mutex::new(HashMap::new()),
            last_selection: Mutex::new(None),
            workspace_folders: vec![],
        };
        let req = json!({ "jsonrpc": "2.0", "id": 7, "method": "bogus" }).to_string();
        let reply: Value = serde_json::from_str(&handle_rpc(&req, &shared).unwrap()).unwrap();
        assert_eq!(reply["error"]["code"], -32601);
    }

    /// End-to-end over a real loopback socket: connect with the right token, run
    /// the handshake, and confirm a pushed selection arrives as a
    /// `selection_changed` notification. Proves the WS server + auth + protocol
    /// without needing the GUI or a live `claude`.
    #[test]
    fn end_to_end_handshake_and_selection_push() {
        let dir = std::env::temp_dir().join(format!("gamut-ide-e2e-{}", std::process::id()));
        let handle = start_server(IdeConfig {
            workspace_folders: vec!["/work".into()],
            lockfile_dir: Some(dir.clone()),
        })
        .unwrap();

        // Read the token the CLI would read from the lockfile.
        let lock: Value = serde_json::from_slice(
            &std::fs::read(dir.join(format!("{}.lock", handle.port()))).unwrap(),
        )
        .unwrap();
        let token = lock["authToken"].as_str().unwrap().to_string();

        // Connect as the CLI would: auth header on the upgrade request.
        let stream = TcpStream::connect(("127.0.0.1", handle.port())).unwrap();
        let mut req = format!("ws://127.0.0.1:{}/", handle.port())
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert(AUTH_HEADER, token.parse().unwrap());
        let (mut client, _resp) = tungstenite::client(req, stream).unwrap();

        // initialize → expect a result echoing our protocol version.
        client
            .send(Message::Text(
                json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
                        "params": { "protocolVersion": "2025-06-18" } })
                .to_string()
                .into(),
            ))
            .unwrap();
        let init: Value = read_json(&mut client);
        assert_eq!(init["id"], 1);
        assert_eq!(init["result"]["serverInfo"]["name"], "gamut");

        // Push a selection; it should arrive as a notification (no id).
        handle.push_selection(sample_selection());
        let note = read_until_method(&mut client, "selection_changed");
        assert_eq!(note["params"]["filePath"], "/tmp/foo.rs");
        assert_eq!(note["params"]["selection"]["start"]["line"], 9);
        assert_eq!(handle.client_count(), 1);

        let _ = client.close(None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A connection presenting the wrong token is rejected at the upgrade.
    #[test]
    fn wrong_token_is_rejected() {
        let dir = std::env::temp_dir().join(format!("gamut-ide-auth-{}", std::process::id()));
        let handle = start_server(IdeConfig {
            workspace_folders: vec![],
            lockfile_dir: Some(dir.clone()),
        })
        .unwrap();
        let stream = TcpStream::connect(("127.0.0.1", handle.port())).unwrap();
        let mut req = format!("ws://127.0.0.1:{}/", handle.port())
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert(AUTH_HEADER, "not-the-token".parse().unwrap());
        assert!(tungstenite::client(req, stream).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn read_json(client: &mut tungstenite::WebSocket<TcpStream>) -> Value {
        loop {
            if let Message::Text(t) = client.read().unwrap() {
                return serde_json::from_str(t.as_str()).unwrap();
            }
        }
    }

    fn read_until_method(client: &mut tungstenite::WebSocket<TcpStream>, method: &str) -> Value {
        for _ in 0..20 {
            let v = read_json(client);
            if v.get("method").and_then(Value::as_str) == Some(method) {
                return v;
            }
        }
        panic!("did not receive {method}");
    }
}
