mod commands;
mod db;
mod error;
mod git;
mod state;

use std::sync::Mutex;

use tauri::Manager;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Database lives in the platform app-data directory, e.g.
            // ~/Library/Application Support/com.rymera.gamut/gamut.db on macOS.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("gamut.db");
            let conn = db::open(&db_path)?;
            app.manage(AppState {
                db: Mutex::new(conn),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::system::ping,
            commands::system::db_health,
            commands::repo::list_repos,
            commands::repo::register_repo,
            commands::repo::remove_repo,
            commands::repo::touch_repo,
            commands::repo::discover_repos,
            commands::repo::list_branches,
            commands::repo::checkout_branch,
            commands::tags::list_tags,
            commands::tags::create_tag,
            commands::tags::delete_tag,
            commands::tags::set_repo_tags,
            commands::tags::list_groups,
            commands::tags::create_group,
            commands::tags::delete_group,
            commands::tags::set_repo_groups,
            commands::history::log,
            commands::history::commit_detail,
            commands::history::file_diff,
            commands::history::file_history,
            commands::history::blame,
            commands::review::review_files,
            commands::review::review_file_diff,
            commands::github::github_set_token,
            commands::github::github_auth_status,
            commands::github::github_logout,
            commands::github::github_list_prs,
            commands::github::github_pr_diff,
            commands::github::github_submit_review,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
