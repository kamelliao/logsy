#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![window_controls, read_text_file, write_text_file, open_url])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
  std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
  std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Open a URL in the user's default browser. Cross-platform via the OS launcher,
/// so no extra crate is needed. Only http(s) URLs are accepted.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
  if !(url.starts_with("http://") || url.starts_with("https://")) {
    return Err("Only http(s) URLs are allowed".into());
  }
  #[cfg(target_os = "windows")]
  let r = std::process::Command::new("cmd").args(["/C", "start", "", url.as_str()]).spawn();
  #[cfg(target_os = "macos")]
  let r = std::process::Command::new("open").arg(&url).spawn();
  #[cfg(all(unix, not(target_os = "macos")))]
  let r = std::process::Command::new("xdg-open").arg(&url).spawn();
  r.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn window_controls(window: tauri::Window, action: &str) {
  match action {
    "minimize" => { let _ = window.minimize(); }
    "maximize" => {
      if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
      } else {
        let _ = window.maximize();
      }
    }
    "close" => { let _ = window.close(); }
    _ => {}
  }
}
