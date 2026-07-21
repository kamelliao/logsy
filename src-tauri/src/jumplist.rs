//! Windows Jump List — the tasks shown when you right-click the app's taskbar
//! icon. We register a single "New Empty Window" task that relaunches the app
//! with `--safe`: a fresh in-memory session that never reads or writes saved
//! state, leaving it intact on disk. It's the desktop equivalent of Chrome's
//! "New incognito window" (which is itself just a Jump List task).
//!
//! Best-effort and non-fatal: any failure just means no Jump List entry.

use std::os::windows::ffi::OsStrExt;

use windows::core::{w, Interface, PCWSTR};
use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
    DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
};

/// Register (or refresh) the app's Jump List. Called once at startup.
pub fn register() {
    if let Err(e) = unsafe { register_inner() } {
        log::warn!("jump list registration failed: {e}");
    }
}

unsafe fn register_inner() -> windows::core::Result<()> {
    // The taskbar button owning the Jump List lives on the UI thread's STA. This
    // runs at setup on the main thread, where wry has already initialized COM;
    // CoInitializeEx then returns S_FALSE ("already initialized"), which is fine —
    // we don't own the apartment, so we don't uninitialize it either.
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

    // The task relaunches THIS executable with `--safe`.
    let exe = std::env::current_exe()
        .map_err(|e| windows::core::Error::new(windows::Win32::Foundation::E_FAIL, e.to_string()))?;
    let exe_w: Vec<u16> = exe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let exe_pcwstr = PCWSTR(exe_w.as_ptr());

    let list: ICustomDestinationList =
        CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
    // BeginList is required before AddUserTasks; it also reports items the user has
    // removed (we re-add none, so the count is ignored).
    let mut slots = 0u32;
    let _removed: IObjectArray = list.BeginList(&mut slots)?;

    let tasks: IObjectCollection =
        CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;

    let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
    link.SetPath(exe_pcwstr)?;
    link.SetArguments(w!("--safe"))?;
    // Borrow the exe's own icon for the entry.
    link.SetIconLocation(exe_pcwstr, 0)?;
    link.SetDescription(w!(
        "Open a new window with a clean session — your saved workspace is left untouched"
    ))?;

    // The visible label comes from PKEY_Title on the link's property store — a user
    // task with no title is silently dropped by the shell.
    let store: IPropertyStore = link.cast()?;
    let title = PROPVARIANT::from("New Empty Window");
    store.SetValue(&PKEY_Title, &title)?;
    store.Commit()?;

    tasks.AddObject(&link)?;
    let array: IObjectArray = tasks.cast()?;
    list.AddUserTasks(&array)?;
    list.CommitList()?;
    Ok(())
}
