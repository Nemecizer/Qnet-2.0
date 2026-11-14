//! The AppKit half of the diagram export (canvas_export.rs): the general pasteboard, the Print
//! panel and Page Setup, as 0.90.34's `CanvasImageExport.copyToPasteboard` / `print` and
//! `NSApp.runPageLayout(nil)` did them. Everything here runs on the main thread; it can only be
//! checked in the running app (ledger notes say "app check").

use crate::errors::QnError;

/// Runs `work` on the main thread and waits for its answer (the command itself runs off it).
pub fn on_main<T: Send + 'static>(app: &tauri::AppHandle, work: impl FnOnce() -> T + Send + 'static) -> Result<T, QnError> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(work());
    })
    .map_err(|e| QnError::failed(e.to_string()))?;
    rx.recv().map_err(|_| QnError::failed("The main thread didn't answer."))
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{c_void, CString};

    use objc2::encode::{Encode, Encoding};
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};

    use crate::errors::QnError;

    // PDFDocument (Print Diagram) lives in PDFKit, which nothing else links.
    #[link(name = "PDFKit", kind = "framework")]
    extern "C" {}

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSSize {
        width: f64,
        height: f64,
    }

    unsafe impl Encode for NSSize {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }

    fn class(name: &std::ffi::CStr) -> Result<&'static AnyClass, QnError> {
        AnyClass::get(name).ok_or_else(|| QnError::failed(format!("AppKit has no {}.", name.to_string_lossy())))
    }

    unsafe fn data(bytes: &[u8]) -> Result<*mut AnyObject, QnError> {
        let d: *mut AnyObject = msg_send![class(c"NSData")?, dataWithBytes: bytes.as_ptr() as *const c_void, length: bytes.len()];
        Ok(d)
    }

    unsafe fn string(s: &str) -> Result<*mut AnyObject, QnError> {
        let c = CString::new(s.replace('\0', "")).unwrap_or_default();
        let s: *mut AnyObject = msg_send![class(c"NSString")?, stringWithUTF8String: c.as_ptr()];
        Ok(s)
    }

    /// PDF and TIFF on the general pasteboard; the TIFF says it is `size` points, so a 2× image
    /// pastes at the diagram's size rather than twice it.
    pub fn copy(pdf: &[u8], png: &[u8], size: (f64, f64)) -> Result<(), QnError> {
        objc2::rc::autoreleasepool(|_| unsafe {
            let board: *mut AnyObject = msg_send![class(c"NSPasteboard")?, generalPasteboard];
            let _: isize = msg_send![board, clearContents];
            let wrote_pdf: Bool = msg_send![board, setData: data(pdf)?, forType: string("com.adobe.pdf")?];
            let rep: *mut AnyObject = msg_send![class(c"NSBitmapImageRep")?, imageRepWithData: data(png)?];
            let mut wrote_tiff = Bool::NO;
            if !rep.is_null() {
                let _: () = msg_send![rep, setSize: NSSize { width: size.0, height: size.1 }];
                let tiff: *mut AnyObject = msg_send![rep, TIFFRepresentation];
                if !tiff.is_null() {
                    wrote_tiff = msg_send![board, setData: tiff, forType: string("public.tiff")?];
                }
            }
            if wrote_pdf.as_bool() || wrote_tiff.as_bool() {
                Ok(())
            } else {
                Err(QnError::failed("The pasteboard refused the diagram."))
            }
        })
    }

    /// The PDF through PDFKit's print operation, scaled down to fit and never up
    /// (kPDFPrintPageScaleDownToFit), on `NSPrintInfo.shared`, run app-modal as 0.90.34's
    /// `NSPrintOperation.run()` was. Returns when the panel closes.
    pub fn print(pdf: &[u8], job_title: &str) -> Result<(), QnError> {
        objc2::rc::autoreleasepool(|_| unsafe {
            let doc: *mut AnyObject = msg_send![class(c"PDFDocument")?, alloc];
            let doc: *mut AnyObject = msg_send![doc, initWithData: data(pdf)?];
            if doc.is_null() {
                return Err(QnError::failed("PDFKit couldn't read the diagram."));
            }
            let info: *mut AnyObject = msg_send![class(c"NSPrintInfo")?, sharedPrintInfo];
            const SCALE_DOWN_TO_FIT: isize = 2;
            let op: *mut AnyObject = msg_send![doc, printOperationForPrintInfo: info, scalingMode: SCALE_DOWN_TO_FIT, autoRotate: Bool::NO];
            if op.is_null() {
                let _: () = msg_send![doc, release];
                return Err(QnError::failed("PDFKit couldn't print the diagram."));
            }
            let _: () = msg_send![op, setJobTitle: string(job_title)?];
            let _: Bool = msg_send![op, runOperation];
            let _: () = msg_send![doc, release];
            Ok(())
        })
    }

    /// File ▸ Page Setup…: `NSApp.runPageLayout(nil)`.
    pub fn page_setup() -> Result<(), QnError> {
        objc2::rc::autoreleasepool(|_| unsafe {
            let ns_app: *mut AnyObject = msg_send![class(c"NSApplication")?, sharedApplication];
            let none: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![ns_app, runPageLayout: none];
            Ok(())
        })
    }
}

#[cfg(target_os = "macos")]
pub use mac::{copy, page_setup, print};

#[cfg(not(target_os = "macos"))]
pub fn copy(_pdf: &[u8], _png: &[u8], _size: (f64, f64)) -> Result<(), QnError> {
    Err(QnError::failed("Copy as Image needs macOS."))
}

#[cfg(not(target_os = "macos"))]
pub fn print(_pdf: &[u8], _job_title: &str) -> Result<(), QnError> {
    Err(QnError::failed("Printing needs macOS."))
}

#[cfg(not(target_os = "macos"))]
pub fn page_setup() -> Result<(), QnError> {
    Err(QnError::failed("Page Setup needs macOS."))
}
