#[cfg(target_os = "windows")]
mod jumplist;

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
      // Register the taskbar-icon Jump List ("New Empty Window" → relaunch with
      // --safe). Windows-only, best-effort — never fail startup over it.
      #[cfg(target_os = "windows")]
      jumplist::register();
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
async fn read_text_file(path: String, encoding: Option<String>) -> Result<ReadResult, String> {
  tauri::async_runtime::spawn_blocking(move || {
    read_text_file_blocking(&path, encoding.as_deref())
  })
  .await
  .map_err(|e| e.to_string())?
}

// `forced` is a user-chosen encoding label (from the sidebar) that overrides
// auto-detection — the escape hatch for the files sniffing gets wrong. An
// unknown label falls back to auto-detection rather than failing the open.
fn read_text_file_blocking(path: &str, forced: Option<&str>) -> Result<ReadResult, String> {
  let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
  Ok(decode_bytes(&bytes, forced))
}

// chardetng scans byte-by-byte, so feeding it a huge log (firmware dumps run to
// hundreds of MB) is what made a mis-sniffed open drag on for seconds. A prefix
// this size is more than enough to recognize any legacy single/multi-byte
// encoding, and bounds detection cost regardless of file size.
const SNIFF_LIMIT: usize = 1 << 20; // 1 MiB

// Decode raw file bytes to text, reporting the encoding actually used. Split out
// from the disk read so it can be unit-tested. A user override wins outright;
// an unknown override label falls back to auto-detection rather than failing.
fn decode_bytes(bytes: &[u8], forced: Option<&str>) -> ReadResult {
  // Pick an encoding. A user override wins outright. Otherwise an explicit BOM
  // wins; failing that, sniff BOM-less UTF-16 ourselves (chardetng never guesses
  // UTF-16 — the Encoding Standard only recognizes it via a BOM — so without this
  // a BOM-less UTF-16 log decodes as a single-byte encoding: the NUL high bytes
  // survive and the stray CR/LF low bytes split lines apart). Then take the fast
  // path for valid UTF-8: chardetng labels a pure-ASCII/UTF-8 file "windows-1252"
  // (harmless to decode but a wrong badge) AND scanning the whole file for the
  // guess is the slow part — a UTF-8 validity check is SIMD-fast and settles the
  // common case outright. Only genuine legacy encodings reach chardetng, and even
  // then we sniff a bounded prefix, not the whole file.
  //
  // Order matters: BOM-less UTF-16 of ASCII (e.g. "A" -> 41 00) is itself valid
  // UTF-8 with embedded NULs, so the UTF-16 sniff must run before the UTF-8 check.
  let forced_enc = forced.and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()));
  let encoding = forced_enc.unwrap_or_else(|| {
    match encoding_rs::Encoding::for_bom(bytes) {
      Some((enc, _bom_len)) => enc,
      None => sniff_bomless_utf16(bytes)
        .or_else(|| std::str::from_utf8(bytes).is_ok().then_some(encoding_rs::UTF_8))
        .unwrap_or_else(|| {
          let sample = &bytes[..bytes.len().min(SNIFF_LIMIT)];
          let mut detector = chardetng::EncodingDetector::new();
          detector.feed(sample, sample.len() == bytes.len());
          detector.guess(None, true)
        }),
    }
  });

  // `decode` re-sniffs any BOM and reports the encoding actually used.
  let (text, used, _had_errors) = encoding.decode(bytes);
  ReadResult { text: text.into_owned(), encoding: used.name().to_string() }
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
  use super::{decode_bytes, sniff_bomless_utf16};

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

  // The traditional-Chinese "測試" in Big5 (0xB4 0xFA 0xB8 0xD5). Auto-detection
  // reads it as some single-byte encoding (mojibake); a forced Big5 label fixes it.
  const BIG5_TEST: &[u8] = &[0xB4, 0xFA, 0xB8, 0xD5];

  #[test]
  fn forced_encoding_overrides_detection() {
    let auto = decode_bytes(BIG5_TEST, None);
    assert_ne!(auto.text, "測試", "auto-detect should not land on Big5 here");
    let forced = decode_bytes(BIG5_TEST, Some("big5"));
    assert_eq!(forced.text, "測試");
    assert_eq!(forced.encoding, "Big5");
  }

  // A longer, realistic CJK log line so detection has enough signal to chew on.
  const CJK: &str = "2026-07-21 12:00:00 [INFO] 系統啟動完成，載入韌體模組 firmware v1.2.3\n韌體初始化：測試通道 0x1A2B，狀態正常，繼續執行後續流程與自我檢測程序\n";

  #[test]
  fn utf8_with_bom() {
    let mut b = vec![0xEF, 0xBB, 0xBF];
    b.extend_from_slice(CJK.as_bytes());
    let r = decode_bytes(&b, None);
    assert_eq!(r.encoding, "UTF-8");
    assert_eq!(r.text, CJK); // BOM stripped
  }

  #[test]
  fn utf16le_with_bom() {
    let mut b = vec![0xFF, 0xFE];
    b.extend_from_slice(&utf16le(CJK));
    let r = decode_bytes(&b, None);
    assert_eq!(r.encoding, "UTF-16LE");
    assert_eq!(r.text, CJK);
  }

  #[test]
  fn utf16be_with_bom() {
    let mut b = vec![0xFE, 0xFF];
    b.extend_from_slice(&utf16be(CJK));
    let r = decode_bytes(&b, None);
    assert_eq!(r.encoding, "UTF-16BE");
    assert_eq!(r.text, CJK);
  }

  #[test]
  fn utf8_cjk_no_bom() {
    // No BOM, non-ASCII UTF-8: the validity fast path must claim it as UTF-8,
    // never mojibake it through a single-byte guess.
    let r = decode_bytes(CJK.as_bytes(), None);
    assert_eq!(r.encoding, "UTF-8");
    assert_eq!(r.text, CJK);
  }

  #[test]
  fn valid_utf8_detected_as_utf8_not_windows() {
    // A UTF-8 file with non-ASCII content must report UTF-8, not the windows-1252
    // chardetng would otherwise land on — and it takes the fast path, not the scan.
    let res = decode_bytes("héllo wörld — log line\n".as_bytes(), None);
    assert_eq!(res.encoding, "UTF-8");

    // Pure ASCII is valid UTF-8 too: it should read UTF-8, not "windows-1252".
    let ascii = decode_bytes(KLOG.as_bytes(), None);
    assert_eq!(ascii.encoding, "UTF-8");
    assert_eq!(ascii.text, KLOG);
  }

  #[test]
  fn unknown_forced_label_falls_back_to_detection() {
    // A bogus label must not blow up — it falls through to auto-detection,
    // yielding the same result as passing no override at all.
    let bogus = decode_bytes(&utf16le(KLOG), Some("not-a-real-encoding"));
    let auto = decode_bytes(&utf16le(KLOG), None);
    assert_eq!(bogus.text, auto.text);
    assert_eq!(bogus.encoding, "UTF-16LE");
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
