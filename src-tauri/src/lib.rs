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

#[derive(serde::Serialize)]
struct ReadResult {
  text: String,
  /// The encoding label the file was decoded with (e.g. "UTF-8", "Big5").
  encoding: String,
}

/// Read a text file, transparently handling non-UTF-8 encodings. A leading BOM
/// (UTF-8 / UTF-16 LE / BE) picks the encoding directly; otherwise chardetng
/// sniffs the bytes (covers UTF-16, Big5, GBK, Shift-JIS, Latin-1, …). Decoding
/// is lossy: undecodable bytes become U+FFFD instead of failing the open.
#[tauri::command]
fn read_text_file(path: String) -> Result<ReadResult, String> {
  let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;

  // Honor a BOM when present, else detect from the content.
  let encoding = match encoding_rs::Encoding::for_bom(&bytes) {
    Some((enc, _bom_len)) => enc,
    None => {
      let mut detector = chardetng::EncodingDetector::new();
      detector.feed(&bytes, true);
      detector.guess(None, true)
    }
  };

  // `decode` re-sniffs any BOM and reports the encoding actually used.
  let (text, used, _had_errors) = encoding.decode(&bytes);
  Ok(ReadResult { text: text.into_owned(), encoding: used.name().to_string() })
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
