// `pub` so the `ide_probe` example can drive the server standalone for a live
// handshake check against a real `claude`, without launching the GUI.
pub mod claude_ide;
mod commands;
mod control;
mod db;
mod error;
mod git;
mod preview;
mod process;
mod state;
mod watch;

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use tauri::{Manager, RunEvent, WindowEvent};

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Origin the Files view's HTML preview iframe loads (#296). A custom
        // scheme — rather than `srcdoc`/`blob:`/`data:` — is what gives the frame
        // its own empty policy container, so a previewed page's own scripts run
        // instead of being refused by the app's `script-src 'self'`. See
        // `preview.rs` for the isolation model.
        .register_uri_scheme_protocol(preview::SCHEME, |_ctx, request| {
            preview::handle_request(&request)
        })
        .setup(|app| {
            // Database lives in the platform app-data directory, e.g.
            // ~/Library/Application Support/com.rymera.gamut/gamut.db on macOS.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("gamut.db");
            let conn = db::open(&db_path)?;
            app.manage(AppState {
                db: Mutex::new(conn),
                gh_token: Mutex::new(None),
                watcher: Mutex::new(None),
                bound_folders: Mutex::new(Vec::new()),
                watched_entry_dirs: Mutex::new(HashMap::new()),
                resync_lock: Mutex::new(()),
                terminals: Mutex::new(HashMap::new()),
                terminal_registry: Mutex::new(Vec::new()),
                git_gate: tokio::sync::Semaphore::new(state::GIT_STATUS_CONCURRENCY),
                origin_slug_cache: Mutex::new(HashMap::new()),
                op_log: Mutex::new(VecDeque::new()),
                // Survive restarts (#301): seed the ring from whatever
                // `errors.log` already holds in this data dir.
                error_log: Mutex::new(commands::diagnostics::hydrate_error_log(&data_dir)),
                ide: Mutex::new(None),
            });

            // Watch registered repos' .git so external changes reflect live.
            // The debounce window is configurable (applied at startup).
            let debounce_ms = commands::settings::parsed(
                &app.state::<AppState>(),
                "pref.watchDebounceMs",
                400u64,
            );
            match watch::RepoWatcher::new(app.handle().clone(), debounce_ms) {
                Ok(w) => {
                    let state = app.state::<AppState>();
                    *state.watcher.lock().unwrap() = Some(w);
                    watch::resync(app.handle());
                }
                Err(e) => eprintln!("repo watcher init failed: {e}"),
            }

            // Local control channel for driving the running window from an
            // external local process. Best-effort: a bind failure just means
            // live UI navigation is unavailable, not that the app fails.
            control::start(app.handle().clone());

            // Claude Code IDE integration: a loopback WebSocket server a
            // `claude` launched in an integrated terminal auto-connects to, so
            // the current editor selection flows in as context. Best-effort — a
            // bind/lockfile failure just disables the integration. Seed
            // `workspaceFolders` with the registered repo roots so the CLI scopes
            // its IDE-backed file ops to the user's repos.
            let workspace_folders = {
                let state = app.state::<AppState>();
                let paths = state
                    .db
                    .lock()
                    .ok()
                    .and_then(|conn| commands::repo::all_repo_paths(&conn).ok());
                paths.unwrap_or_default()
            };
            match claude_ide::start_server(claude_ide::IdeConfig {
                workspace_folders,
                lockfile_dir: None,
            }) {
                Ok(handle) => {
                    *app.state::<AppState>().ide.lock().unwrap() = Some(handle);
                }
                Err(e) => eprintln!("claude IDE server init failed: {e}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::system::ping,
            commands::system::db_health,
            commands::repo::list_repos,
            commands::repo::repo_statuses,
            commands::repo::repo_statuses_for,
            commands::repo::repo_status,
            commands::repo::register_repo,
            commands::repo::remove_repo,
            commands::repo::touch_repo,
            commands::repo::reorder_repos,
            commands::repo::discover_repos,
            commands::repo::sync_group_folder,
            commands::repo::list_branches,
            commands::repo::list_git_tags,
            commands::repo::checkout_branch,
            commands::repo::create_branch,
            commands::cleanup::list_stale_branches,
            commands::cleanup::delete_branches,
            commands::tags::list_tags,
            commands::tags::create_tag,
            commands::tags::delete_tag,
            commands::tags::set_repo_tags,
            commands::tags::list_groups,
            commands::tags::create_group,
            commands::tags::update_group,
            commands::tags::reorder_groups,
            commands::tags::delete_group,
            commands::tags::bind_group_folder,
            commands::tags::unbind_group_folder,
            commands::tags::set_repo_groups,
            commands::history::log,
            commands::history::commit_detail,
            commands::history::file_diff,
            commands::history::file_history,
            commands::history::blame,
            commands::files::list_dir,
            commands::files::read_file,
            commands::files::read_image_file,
            commands::files::write_file,
            commands::files::create_file,
            commands::files::create_dir,
            commands::files::delete_path,
            commands::files::rename_path,
            commands::files::resolve_path,
            commands::files::resolve_terminal_path,
            commands::files::reveal_in_file_manager,
            commands::sound::play_notification_sound,
            commands::review::review_files,
            commands::review::review_file_diff,
            commands::compare::compare_files,
            commands::compare::compare_refs,
            commands::compare::write_compare_file,
            commands::search::search_repo,
            commands::search::replace_in_files,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::delete_setting,
            commands::settings::get_settings,
            commands::settings::reset_settings,
            commands::sync::git_sync_status,
            commands::sync::git_fetch,
            commands::sync::git_fetch_many,
            commands::sync::git_pull,
            commands::sync::git_push,
            commands::sync::git_checkout_pr,
            commands::worktree::git_worktree_status,
            commands::worktree::git_worktree_list,
            commands::worktree::worktree_file_diff,
            commands::worktree::git_stage,
            commands::worktree::git_unstage,
            commands::worktree::git_discard,
            commands::worktree::git_commit,
            commands::worktree::git_stash_list,
            commands::worktree::git_stash_push,
            commands::worktree::git_stash_pop,
            commands::worktree::git_stash_apply,
            commands::worktree::git_stash_drop,
            commands::github::github_set_token,
            commands::github::github_auth_status,
            commands::github::github_logout,
            commands::github::github_check,
            commands::github::github_oauth_available,
            commands::github::github_device_start,
            commands::github::github_device_poll,
            commands::github::github_list_prs,
            commands::github::github_resolve_pr_url,
            commands::github::repo_remote_url,
            commands::github::github_pr_diff,
            commands::github::github_commit_avatar,
            commands::github::github_fetch_image,
            commands::github::github_pr_thread,
            commands::github::github_pr_timeline,
            commands::github::github_submit_review,
            commands::github::github_request_review,
            commands::github::github_pr_comment,
            commands::github::github_update_body,
            commands::github::github_mentionables,
            commands::github::github_review_threads,
            commands::github::github_reply_review_comment,
            commands::github::github_resolve_thread,
            commands::github::github_pr_details,
            commands::github::github_merge_pr,
            commands::github::github_mark_pr_ready,
            commands::github::github_convert_pr_to_draft,
            commands::github::github_remote_branch_exists,
            commands::terminal::terminal_spawn,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_kill,
            commands::terminal::terminal_registry_report,
            commands::updater::check_for_update,
            commands::updater::download_and_install_update,
            commands::diagnostics::diagnostics_snapshot,
            commands::diagnostics::diagnostics_write,
            commands::diagnostics::diagnostics_record_stall,
            commands::diagnostics::errors_record,
            commands::diagnostics::errors_clear,
            commands::ide::ide_status,
            commands::ide::ide_selection_changed,
        ])
        .on_window_event(|window, event| {
            // Tear down all PTYs when the main window closes so no shell is left
            // orphaned (the OS would reap them on process exit, but be explicit).
            if matches!(
                event,
                WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
            ) {
                commands::terminal::kill_all(&window.state::<AppState>());
                // Drop the control-channel port file so a later client reports
                // "app not running" instead of dialing a dead port.
                control::cleanup(window.app_handle());
                // Remove the IDE lockfile so a later `claude` doesn't dial a
                // dead port.
                if let Some(h) = window
                    .state::<AppState>()
                    .ide
                    .lock()
                    .ok()
                    .and_then(|h| h.clone())
                {
                    h.cleanup();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // Also drop the control-channel files on app-level quit (e.g. Cmd+Q),
            // which exits through RunEvent::Exit without necessarily firing the
            // window CloseRequested/Destroyed events handled above. cleanup() is
            // idempotent, so overlapping with those hooks is harmless.
            if let RunEvent::Exit = event {
                control::cleanup(app_handle);
                if let Some(h) = app_handle
                    .try_state::<AppState>()
                    .and_then(|s| s.ide.lock().ok().and_then(|h| h.clone()))
                {
                    h.cleanup();
                }
            }
        });
}
