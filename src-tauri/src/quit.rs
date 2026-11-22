//! Routes AppKit's `terminate:` (Dock → Quit, logout, AppleScript `quit`) through the
//! save-before-exit handshake. tao's application delegate does not implement
//! `applicationShouldTerminate:`, so AppKit would end the process without asking.
//!
//! The delegate answers NSTerminateLater and starts the usual `exit-requested` flush;
//! AppKit then waits in a modal run loop mode that tao's event-loop source and
//! observers (registered for the common modes) still serve, so IPC keeps flowing.
//! `allow_exit` / `cancel_exit` deliver the deferred answer.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
use tauri::AppHandle;

static APP: OnceLock<AppHandle> = OnceLock::new();
/// AppKit is waiting for `replyToApplicationShouldTerminate:`.
static AWAITING_REPLY: AtomicBool = AtomicBool::new(false);

type ShouldTerminate =
    extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> NSApplicationTerminateReply;

extern "C-unwind" fn should_terminate(
    _this: &AnyObject,
    _sel: Sel,
    _sender: *mut AnyObject,
) -> NSApplicationTerminateReply {
    let Some(app) = APP.get() else {
        return NSApplicationTerminateReply::TerminateNow;
    };
    if crate::exit_allowed(app) {
        return NSApplicationTerminateReply::TerminateNow;
    }
    if !AWAITING_REPLY.swap(true, Ordering::SeqCst) {
        // Same path as the Quit menu item: `RunEvent::ExitRequested` asks for a flush.
        app.exit(0);
    }
    NSApplicationTerminateReply::TerminateLater
}

/// Answers a deferred `applicationShouldTerminate:`. Returns false when AppKit was not
/// waiting for an answer (quit started from the menu or by `app.exit`).
pub fn answer_pending(app: &AppHandle, terminate: bool) -> bool {
    if !AWAITING_REPLY.swap(false, Ordering::SeqCst) {
        return false;
    }
    let sent = app.run_on_main_thread(move || {
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(terminate);
        }
    });
    if let Err(e) = sent {
        eprintln!("tasks: cannot answer the pending quit request: {e}");
    }
    true
}

/// Adds `applicationShouldTerminate:` to the app delegate's class. Must run on the main
/// thread after the event loop (and with it the delegate) exists, before it runs.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("tasks: quit handler must be installed on the main thread");
        return;
    };
    let Some(delegate) = NSApplication::sharedApplication(mtm).delegate() else {
        eprintln!("tasks: no application delegate; quitting from the Dock skips saving");
        return;
    };
    let object: &AnyObject = delegate.as_ref();
    let class = object.class() as *const AnyClass as *mut AnyClass;
    // SAFETY: `should_terminate` matches the selector's signature, described by the
    // type encoding (NSUInteger return, self, _cmd, sender).
    let added = unsafe {
        let imp = std::mem::transmute::<ShouldTerminate, Imp>(should_terminate);
        objc2::ffi::class_addMethod(class, sel!(applicationShouldTerminate:), imp, c"Q@:@".as_ptr())
    };
    if !added.as_bool() {
        eprintln!("tasks: the app delegate already implements applicationShouldTerminate:");
    }
}
