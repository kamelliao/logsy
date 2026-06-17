#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Startup escape hatches for when persisted state makes the app freeze/crash on
  // launch (the UI is then unreachable, so it can't clear its own state).
  // Both work by injecting a script that runs in the webview BEFORE the app
  // bundle, so it takes effect even if the bundle would otherwise hang.
  //   --reset : wipe persisted state permanently, then start fresh.
  //   --safe  : start from a clean in-memory state for THIS session without
  //             reading or writing persisted state, so the bad state survives on
  //             disk for recovery and the next normal launch resumes it.
  let args: Vec<String> = std::env::args().collect();
  let reset = args.iter().any(|a| a == "--reset");
  let safe = args.iter().any(|a| a == "--safe");
  let mut init_script = String::new();
  if reset {
    init_script.push_str("try{localStorage.clear();sessionStorage.clear();}catch(e){}");
  }
  if safe {
    init_script.push_str("window.__LOGSY_SAFE_MODE__=true;");
  }

  let mut builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init());
  if !init_script.is_empty() {
    builder = builder.plugin(
      tauri::plugin::Builder::<tauri::Wry>::new("recovery")
        .js_init_script(init_script)
        .build(),
    );
  }

  builder
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
// `async` so Tauri runs it off the main thread, and the blocking file read +
// decode go through `spawn_blocking` onto a worker thread. A synchronous command
// runs on the main thread, where a slow read (e.g. a file on a disconnected
// network share, which can stall for the Windows SMB/IO timeout) would freeze
// the whole window's event loop. Off-thread, a stalled read leaves the UI
// responsive and still surfaces as a rejected promise on the JS side.
#[tauri::command]
async fn read_text_file(path: String) -> Result<ReadResult, String> {
  tauri::async_runtime::spawn_blocking(move || read_text_file_blocking(&path))
    .await
    .map_err(|e| e.to_string())?
}

fn read_text_file_blocking(path: &str) -> Result<ReadResult, String> {
  let bytes = std::fs::read(path).map_err(|e| e.to_string())?;

  // Pick an encoding. An explicit BOM wins. Otherwise sniff BOM-less UTF-16
  // ourselves before falling back to chardetng: chardetng never guesses UTF-16
  // (the Encoding Standard only recognizes it via a BOM), so without this a
  // BOM-less UTF-16 log decodes as a single-byte encoding — the NUL high bytes
  // survive and the stray CR/LF low bytes split lines apart, producing the
  // broken / blank-line output. Finally fall back to chardetng for the legacy
  // single-byte and multi-byte encodings it does handle.
  let encoding = match encoding_rs::Encoding::for_bom(&bytes) {
    Some((enc, _bom_len)) => enc,
    None => sniff_bomless_utf16(&bytes).unwrap_or_else(|| {
      let mut detector = chardetng::EncodingDetector::new();
      detector.feed(&bytes, true);
      detector.guess(None, true)
    }),
  };

  // `decode` re-sniffs any BOM and reports the encoding actually used.
  let (text, used, _had_errors) = encoding.decode(&bytes);
  Ok(ReadResult { text: text.into_owned(), encoding: used.name().to_string() })
}

/// Detect BOM-less UTF-16 from its tell-tale NUL pattern. Mostly-ASCII text
/// (log files, kernel dumps) leaves a NUL in every "high" byte: at odd offsets
/// for little-endian, even offsets for big-endian. Requires a strong, one-sided
/// signal so ordinary single-byte text and binary blobs don't trip it. Returns
/// None when the bytes don't look like UTF-16.
fn sniff_bomless_utf16(bytes: &[u8]) -> Option<&'static encoding_rs::Encoding> {
  // A bounded prefix is plenty to judge the pattern.
  let sample = &bytes[..bytes.len().min(4096)];
  if sample.len() < 16 {
    return None;
  }
  let pairs = sample.len() / 2;
  let (mut even_nul, mut odd_nul) = (0usize, 0usize);
  for (i, &b) in sample.iter().enumerate() {
    if b == 0 {
      if i % 2 == 0 {
        even_nul += 1;
      } else {
        odd_nul += 1;
      }
    }
  }
  let strong = pairs * 8 / 10; // >= ~80% of the "high" bytes are NUL
  let weak = pairs / 10; //       < ~10% NUL on the "text" side
  if odd_nul >= strong && even_nul <= weak {
    Some(encoding_rs::UTF_16LE)
  } else if even_nul >= strong && odd_nul <= weak {
    Some(encoding_rs::UTF_16BE)
  } else {
    None
  }
}

#[cfg(test)]
mod tests {
  use super::sniff_bomless_utf16;

  fn utf16le(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
  }
  fn utf16be(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(|u| u.to_be_bytes()).collect()
  }

  const KLOG: &str = "[    0.000000] Linux version 6.8.0-generic\n[    0.000001] Command line: ro quiet splash\n";

  #[test]
  fn detects_bomless_utf16le() {
    assert_eq!(sniff_bomless_utf16(&utf16le(KLOG)), Some(encoding_rs::UTF_16LE));
  }

  #[test]
  fn detects_bomless_utf16be() {
    assert_eq!(sniff_bomless_utf16(&utf16be(KLOG)), Some(encoding_rs::UTF_16BE));
  }

  #[test]
  fn ignores_plain_ascii_and_utf8() {
    assert_eq!(sniff_bomless_utf16(KLOG.as_bytes()), None);
    assert_eq!(sniff_bomless_utf16("日本語のログ行 plus ascii padding for length".as_bytes()), None);
  }

  #[test]
  fn ignores_short_input() {
    assert_eq!(sniff_bomless_utf16(&utf16le("hi")), None);
  }
}

// Async + off-thread for the same reason as `read_text_file`: keep a blocking
// write to a slow/disconnected path from freezing the main-thread event loop.
#[tauri::command]
async fn write_text_file(path: String, contents: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || std::fs::write(&path, contents).map_err(|e| e.to_string()))
    .await
    .map_err(|e| e.to_string())?
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
