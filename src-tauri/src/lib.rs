mod commands;
mod db;
mod services;

use std::{path::PathBuf, sync::Arc, thread, time::Duration};
use tauri::{Manager, State};
use tokio::runtime::Runtime;

pub struct AppState {
    pub db_path: PathBuf,
}

#[tauri::command]
fn app_status(state: State<'_, AppState>) -> Result<String, String> {
    db::init(&state.db_path).map_err(|e| e.to_string())?;
    Ok("Локальное ядро запущено".into())
}

#[tauri::command]
fn save_credentials(client_id: String, client_secret: String, openai_api_key: String, telegram_bot_token: String, telegram_chat_id: String, state: State<'_, AppState>) -> Result<(), String> {
    services::secrets::set("google_client_id", &client_id)?;
    services::secrets::set("google_client_secret", &client_secret)?;
    services::secrets::set("openai_api_key", &openai_api_key)?;
    services::secrets::set("telegram_bot_token", &telegram_bot_token)?;
    db::set_setting(&state.db_path, "telegram_chat_id", &telegram_chat_id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_config_state(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let chat = db::get_setting(&state.db_path, "telegram_chat_id").map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "gmail": services::secrets::get("google_client_id").is_ok_and(|v| !v.is_empty()),
        "openai": services::secrets::get("openai_api_key").is_ok_and(|v| !v.is_empty()),
        "telegram": services::secrets::get("telegram_bot_token").is_ok_and(|v| !v.is_empty()) && chat.is_some()
    }))
}

#[tauri::command]
fn connect_gmail(state: State<'_, AppState>) -> Result<String, String> {
    services::gmail::oauth_and_connect(&state.db_path)
}

#[tauri::command]
async fn test_telegram(state: State<'_, AppState>) -> Result<String, String> {
    let token = services::secrets::get("telegram_bot_token")?;
    let chat = db::get_setting(&state.db_path, "telegram_chat_id").map_err(|e| e.to_string())?.ok_or("Telegram chat_id не задан")?;
    services::telegram::test(&token, &chat).await
}

#[tauri::command]
fn sync_now(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let rt = Runtime::new().map_err(|e| e.to_string())?;
    rt.block_on(services::processor::sync_and_process(&state.db_path)).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_emails(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    db::list_emails(&state.db_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_posts(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    db::list_posts(&state.db_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn publish_post(post_id: String, state: State<'_, AppState>) -> Result<String, String> {
    let rt = Runtime::new().map_err(|e| e.to_string())?;
    rt.block_on(services::processor::publish_post(&state.db_path, &post_id)).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_automation(input: serde_json::Value, state: State<'_, AppState>) -> Result<String, String> {
    db::upsert_automation(&state.db_path, &input).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_settings(interval_minutes: u64, autostart: bool, background: bool, state: State<'_, AppState>) -> Result<(), String> {
    db::set_setting(&state.db_path, "interval_minutes", &interval_minutes.to_string()).map_err(|e| e.to_string())?;
    db::set_setting(&state.db_path, "autostart", if autostart { "1" } else { "0" }).map_err(|e| e.to_string())?;
    db::set_setting(&state.db_path, "background", if background { "1" } else { "0" }).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .setup(|app| {
            let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
            let db_path = data.join("mail2telegram.sqlite3");
            db::init(&db_path).map_err(|e| e.to_string())?;
            app.manage(AppState { db_path: db_path.clone() });

            let path = Arc::new(db_path);
            thread::spawn(move || {
                loop {
                    let mins = db::get_setting(&path, "interval_minutes").ok().flatten().and_then(|v| v.parse::<u64>().ok()).unwrap_or(5).max(1);
                    if let Ok(rt) = Runtime::new() {
                        let _ = rt.block_on(services::processor::sync_and_process(&path));
                    }
                    thread::sleep(Duration::from_secs(mins * 60));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_status, save_credentials, get_config_state, connect_gmail, test_telegram,
            sync_now, list_emails, list_posts, publish_post, save_automation, save_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mail2Telegram");
}
