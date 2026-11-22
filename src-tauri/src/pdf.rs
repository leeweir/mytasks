//! Offscreen HTML → paginated PDF export through WKWebView's print operation.

use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, State};
use tokio::sync::oneshot;

use crate::export::ExportState;

/// Upper bound for loading + printing a document.
const EXPORT_TIMEOUT: Duration = Duration::from_secs(120);

type Reply = oneshot::Sender<Result<(), String>>;

#[cfg(target_os = "macos")]
mod imp {
    use super::Reply;
    use std::cell::{Cell, RefCell};
    use std::ffi::c_void;
    use std::path::PathBuf;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSBackingStoreType, NSPrintInfo, NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob,
        NSPrintingPaginationMode, NSWindow, NSWindowStyleMask,
    };
    use objc2_foundation::{
        NSError, NSNumber, NSObjectNSThreadPerformAdditions, NSPoint, NSRect, NSSize, NSString, NSURL,
    };
    use objc2_web_kit::{
        WKNavigation, WKNavigationDelegate, WKWebView, WKWebViewConfiguration,
    };

    /// A4 in points.
    const PAPER: NSSize = NSSize::new(595.2756, 841.8898);
    const MARGIN: f64 = 36.0;

    pub struct JobIvars {
        id: u64,
        out_path: PathBuf,
        /// The print job writes here; renamed over `out_path` only on success.
        tmp_path: PathBuf,
        reply: RefCell<Option<Reply>>,
        window: RefCell<Option<Retained<NSWindow>>>,
        web_view: RefCell<Option<Retained<WKWebView>>>,
        printing: Cell<bool>,
    }

    thread_local! {
        /// Jobs in flight (the web view only holds its navigation delegate weakly).
        static JOBS: RefCell<Vec<Retained<PdfJob>>> = const { RefCell::new(Vec::new()) };
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "TasksPdfExportJob"]
        #[ivars = JobIvars]
        pub struct PdfJob;

        unsafe impl NSObjectProtocol for PdfJob {}

        unsafe impl WKNavigationDelegate for PdfJob {
            #[unsafe(method(webView:didFinishNavigation:))]
            fn did_finish(&self, _web_view: &WKWebView, _navigation: Option<&WKNavigation>) {
                self.print();
            }

            #[unsafe(method(webView:didFailNavigation:withError:))]
            fn did_fail(
                &self,
                _web_view: &WKWebView,
                _navigation: Option<&WKNavigation>,
                error: &NSError,
            ) {
                self.fail(format!("cannot render HTML: {error}"));
            }

            #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
            fn did_fail_provisional(
                &self,
                _web_view: &WKWebView,
                _navigation: Option<&WKNavigation>,
                error: &NSError,
            ) {
                self.fail(format!("cannot load HTML: {error}"));
            }

            #[unsafe(method(webViewWebContentProcessDidTerminate:))]
            fn content_process_did_terminate(&self, _web_view: &WKWebView) {
                self.fail("the page renderer quit unexpectedly".to_string());
            }
        }

        impl PdfJob {
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn print_did_run(
                &self,
                _operation: &NSPrintOperation,
                success: Bool,
                _context: *mut c_void,
            ) {
                // AppKit invokes this on its print worker. Do not access the job's
                // main-thread-only state here; Foundation retains the queued receiver.
                unsafe {
                    self.performSelectorOnMainThread_withObject_waitUntilDone(
                        sel!(completePrint:),
                        Some(&NSNumber::new_bool(success.as_bool())),
                        false,
                    );
                }
            }

            #[unsafe(method(completePrint:))]
            fn complete_print(&self, success: &NSNumber) {
                let ivars = self.ivars();
                let (out, tmp) = (&ivars.out_path, &ivars.tmp_path);
                let result = if ivars.reply.borrow().is_none() {
                    // Already answered (timeout or renderer crash): keep the old file.
                    Err(String::new())
                } else if success.as_bool() && tmp.is_file() {
                    std::fs::rename(tmp, out)
                        .map_err(|e| format!("cannot write {}: {e}", out.display()))
                } else {
                    Err(format!("PDF export to {} failed", out.display()))
                };
                self.finish(result);
            }
        }
    );

    impl PdfJob {
        fn print(&self) {
            if self.ivars().printing.replace(true) {
                return;
            }
            let Some(window) = self.ivars().window.borrow().clone() else {
                return;
            };
            let Some(web_view) = self.ivars().web_view.borrow().clone() else {
                return;
            };
            let url = NSURL::fileURLWithPath(&NSString::from_str(
                &self.ivars().tmp_path.to_string_lossy(),
            ));

            let info = NSPrintInfo::new();
            info.setPaperSize(PAPER);
            info.setTopMargin(MARGIN);
            info.setBottomMargin(MARGIN);
            info.setLeftMargin(MARGIN);
            info.setRightMargin(MARGIN);
            info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
            info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
            info.setHorizontallyCentered(false);
            info.setVerticallyCentered(false);
            unsafe {
                info.setJobDisposition(NSPrintSaveJob);
                info.dictionary()
                    .setObject_forKey(&url, ProtocolObject::from_ref(NSPrintJobSavingURL));
            }

            let operation = unsafe { web_view.printOperationWithPrintInfo(&info) };
            // WebKit needs the main run loop free to compute pagination for the print worker.
            operation.setCanSpawnSeparateThread(true);
            operation.setShowsPrintPanel(false);
            operation.setShowsProgressPanel(false);
            let delegate: &AnyObject = self.as_ref();
            unsafe {
                operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                    &window,
                    Some(delegate),
                    Some(sel!(printOperationDidRun:success:contextInfo:)),
                    std::ptr::null_mut(),
                );
            }
        }

        /// Fails the export. While a print operation runs, only the reply is sent: the
        /// job must stay alive as the operation's delegate until its callback.
        fn fail(&self, error: String) {
            if self.ivars().printing.get() {
                if let Some(reply) = self.ivars().reply.borrow_mut().take() {
                    let _ = reply.send(Err(error));
                }
            } else {
                self.finish(Err(error));
            }
        }

        /// Replies once, tears down the offscreen window and releases the job.
        fn finish(&self, result: Result<(), String>) {
            if let Some(reply) = self.ivars().reply.borrow_mut().take() {
                // The awaiting command may have timed out; nothing to do then.
                let _ = reply.send(result);
            }
            // Gone already after a successful rename.
            let _ = std::fs::remove_file(&self.ivars().tmp_path);
            if let Some(web_view) = self.ivars().web_view.borrow_mut().take() {
                unsafe {
                    web_view.setNavigationDelegate(None);
                    web_view.stopLoading();
                }
            }
            if let Some(window) = self.ivars().window.borrow_mut().take() {
                window.setContentView(None);
                window.close();
            }
            let id = self.ivars().id;
            let job = JOBS.with(|jobs| {
                let mut jobs = jobs.borrow_mut();
                jobs.iter()
                    .position(|j| j.ivars().id == id)
                    .map(|i| jobs.remove(i))
            });
            // `self` may be the last reference: release it after the current call returns.
            if let Some(job) = job {
                let _ = Retained::autorelease_ptr(job);
            }
        }
    }

    pub fn start(
        mtm: MainThreadMarker,
        id: u64,
        html: &str,
        out_path: PathBuf,
        tmp_path: PathBuf,
        reply: Reply,
    ) {
        let frame = NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(PAPER.width - 2.0 * MARGIN, PAPER.height - 2.0 * MARGIN),
        );
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(mtm),
                frame,
                NSWindowStyleMask::Borderless,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        unsafe { window.setReleasedWhenClosed(false) };
        let web_view = unsafe {
            WKWebView::initWithFrame_configuration(
                WKWebView::alloc(mtm),
                frame,
                &WKWebViewConfiguration::new(mtm),
            )
        };
        window.setContentView(Some(&web_view));

        let job = PdfJob::alloc(mtm).set_ivars(JobIvars {
            id,
            out_path,
            tmp_path,
            reply: RefCell::new(Some(reply)),
            window: RefCell::new(Some(window)),
            web_view: RefCell::new(Some(web_view.clone())),
            printing: Cell::new(false),
        });
        let job: Retained<PdfJob> = unsafe { msg_send![super(job), init] };
        JOBS.with(|jobs| jobs.borrow_mut().push(job.clone()));

        unsafe {
            web_view.setNavigationDelegate(Some(ProtocolObject::from_ref(&*job)));
            // Images are embedded as data: URLs; the page gets no file access.
            let base = NSURL::URLWithString(&NSString::from_str("about:blank"));
            web_view.loadHTMLString_baseURL(&NSString::from_str(html), base.as_deref());
        }
    }

    /// Stop waiting on a timed-out job, retaining any active print delegate until its callback.
    pub fn cancel(id: u64) {
        let job = JOBS.with(|jobs| jobs.borrow().iter().find(|j| j.ivars().id == id).cloned());
        if let Some(job) = job {
            job.fail("PDF export timed out".to_string());
        }
    }
}

/// Renders `html` to a PDF at `out_path`, which must come from `choose_export_path`.
/// The previous file is replaced only after printing succeeded.
#[tauri::command]
pub async fn export_pdf(
    app: AppHandle,
    exports: State<'_, ExportState>,
    html: String,
    out_path: String,
) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);

    let out_path = exports.take(&out_path)?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let name = out_path
        .file_name()
        .ok_or_else(|| format!("invalid export path: {}", out_path.display()))?
        .to_string_lossy();
    let tmp_path = out_path.with_file_name(format!(".{name}.{}-{id}.tmp.pdf", std::process::id()));
    let (tx, rx) = oneshot::channel();
    start(&app, id, html, out_path, tmp_path, tx)?;
    match tokio::time::timeout(EXPORT_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("PDF export was aborted".to_string()),
        Err(_) => {
            #[cfg(target_os = "macos")]
            app.run_on_main_thread(move || imp::cancel(id))
                .map_err(|e| e.to_string())?;
            Err("PDF export timed out".to_string())
        }
    }
}

#[cfg(target_os = "macos")]
fn start(
    app: &AppHandle,
    id: u64,
    html: String,
    out_path: PathBuf,
    tmp_path: PathBuf,
    reply: Reply,
) -> Result<(), String> {
    app.run_on_main_thread(move || {
        let mtm = objc2::MainThreadMarker::new().expect("run_on_main_thread runs on the main thread");
        imp::start(mtm, id, &html, out_path, tmp_path, reply);
    })
    .map_err(|e| format!("cannot start PDF export: {e}"))
}

#[cfg(not(target_os = "macos"))]
fn start(
    _app: &AppHandle,
    _id: u64,
    _html: String,
    _out_path: PathBuf,
    _tmp_path: PathBuf,
    _reply: Reply,
) -> Result<(), String> {
    Err("PDF export is only supported on macOS".to_string())
}
