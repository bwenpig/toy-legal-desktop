// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// SQLite 資料庫檔位置：
/// macOS: ~/Library/Application Support/com.toysgallery.accounting/toys-gallery.db
/// 由 @tauri-apps/plugin-sql 在前端開啟，前端 JS adapter 全權負責讀寫。
/// Rust 側只註冊 plugin，不直接碰 DB，方便將來加 backup / migration command。
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .run(tauri::generate_context!())
        .expect("error while running Toys Gallery 會計系統");
}
