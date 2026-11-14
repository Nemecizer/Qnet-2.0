//! The diagram as a file, on the pasteboard and on paper (0.90.34 `CanvasImageExport.swift`,
//! ledger §3.14, §8.11, MENU-022/023/030/031/037).
//!
//! The interface draws the figure: the canvas's own layers rendered to one standalone SVG in the
//! light colours (src/canvas/export/figure.tsx), so a figure can't drift from the screen. Rust
//! turns that SVG into a vector PDF (krilla + krilla-svg: one page the size of the figure, text kept
//! as text in embedded subset fonts) or a PNG (resvg at 1×, 2× or 4×, always opaque), and writes
//! the file, fills the pasteboard or prints (canvas_native.rs).
//!
//! Fonts. The canvas draws in the system font, SF Pro (`/System/Library/Fonts/SFNS.ttf`, family
//! "System Font"), which is a variable font: usvg 0.47 maps `font-weight` onto its `wght` axis and
//! krilla embeds each weight as its own instanced subset, so a semibold node name stays semibold
//! in the PDF and the PNG. The CSS names a web page uses for it (`-apple-system`,
//! `BlinkMacSystemFont`, `system-ui`, "SF Pro…") are aliases of that face here, and it is the
//! generic `sans-serif`; on a Mac without SFNS.ttf, Helvetica Neue takes its place. Every other
//! installed font is loaded too, as the fallback for a character SF Pro lacks.

use std::path::Path;
use std::sync::{Arc, OnceLock};

use usvg::fontdb;

use crate::documents::file_name;
use crate::errors::{ErrorKind, QnError};

/// The system font's family name as fontdb reads it from SFNS.ttf.
pub const SYSTEM_FAMILY: &str = "System Font";
/// Where SFNS.ttf is missing (it ships with every macOS since 10.11).
pub const FALLBACK_FAMILY: &str = "Helvetica Neue";
/// CSS names for the system font that a page uses and fontdb doesn't know.
const SYSTEM_ALIASES: [&str; 9] = ["-apple-system", "BlinkMacSystemFont", "system-ui", "ui-sans-serif", "SF Pro", "SF Pro Text", "SF Pro Display", "SF NS", ".SF NS"];

/// The PNG scales the options panel offers (0.90.34 `CanvasExportOptions.pixelScales`).
pub const PIXEL_SCALES: [u32; 3] = [1, 2, 4];

/// The font database every render shares: built once, on the first export.
fn fonts() -> Arc<fontdb::Database> {
    static DB: OnceLock<Arc<fontdb::Database>> = OnceLock::new();
    DB.get_or_init(|| Arc::new(font_database())).clone()
}

fn font_database() -> fontdb::Database {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    // The system font, also under the names a page calls it by.
    let system = db.faces().find(|f| f.families.iter().any(|(n, _)| n == SYSTEM_FAMILY)).map(|f| (f.id, f.clone()));
    if let Some((id, mut info)) = system {
        db.remove_face(id);
        for alias in SYSTEM_ALIASES {
            info.families.push((alias.to_string(), fontdb::Language::English_UnitedStates));
        }
        db.push_face_info(info);
    }
    let family = sans_family(&db);
    db.set_sans_serif_family(family);
    db
}

/// SF Pro when it is installed, else Helvetica Neue.
fn sans_family(db: &fontdb::Database) -> &'static str {
    if db.faces().any(|f| f.families.iter().any(|(n, _)| n == SYSTEM_FAMILY)) {
        SYSTEM_FAMILY
    } else {
        FALLBACK_FAMILY
    }
}

/// The family text with no `font-family` of its own is set in.
#[cfg(test)]
pub fn default_family() -> &'static str {
    sans_family(&fonts())
}

fn render_failed(why: impl std::fmt::Display) -> QnError {
    // The interface writes 0.90.34's sentence for this kind; the reason is only for the log.
    QnError::invalid("Qnet couldn't render the diagram.").with_detail(why.to_string())
}

/// Parses the figure's SVG with the shared fonts.
pub fn parse(svg: &str) -> Result<usvg::Tree, QnError> {
    let db = fonts();
    let options = usvg::Options { font_family: sans_family(&db).to_string(), fontdb: db, ..usvg::Options::default() };
    usvg::Tree::from_str(svg, &options).map_err(render_failed)
}

/// One vector page the size of the figure, in points (1 SVG unit = 1 pt), text embedded.
pub fn pdf(tree: &usvg::Tree) -> Result<Vec<u8>, QnError> {
    use krilla_svg::{SurfaceExt, SvgSettings};
    let (w, h) = (tree.size().width(), tree.size().height());
    let page_size = krilla::geom::Size::from_wh(w, h).ok_or_else(|| render_failed("the figure has no size"))?;
    let settings = krilla::page::PageSettings::from_wh(w, h).ok_or_else(|| render_failed("the figure has no size"))?;
    let mut doc = krilla::Document::new();
    let mut page = doc.start_page_with(settings);
    let mut surface = page.surface();
    surface.draw_svg(tree, page_size, SvgSettings::default()).ok_or_else(|| render_failed("krilla-svg drew nothing"))?;
    surface.finish();
    page.finish();
    doc.finish().map_err(|e| render_failed(format!("{e:?}")))
}

/// The figure as pixels at `scale` pixels per point, composed on white: a PNG is always opaque
/// (0.90.34 `ImageRenderer.isOpaque`).
pub fn pixmap(tree: &usvg::Tree, scale: u32) -> Result<resvg::tiny_skia::Pixmap, QnError> {
    if !PIXEL_SCALES.contains(&scale) {
        return Err(QnError::invalid(format!("{scale}× isn't a scale Qnet exports at.")));
    }
    let s = scale as f32;
    let (wf, hf) = ((tree.size().width() * s).ceil(), (tree.size().height() * s).ceil());
    // A layout spread over the whole world (±100,000 pt) at 4× would ask for gigabytes; refuse
    // anything over 32,767 px a side or 200 megapixels, with a sentence that says what to do.
    if wf > 32_767.0 || hf > 32_767.0 || (wf as f64) * (hf as f64) > 200.0e6 {
        return Err(QnError::invalid(format!(
            "The figure would be {wf} × {hf} pixels, too large to export as PNG. Choose a smaller scale, or export it as PDF."
        )));
    }
    let (w, h) = (wf as u32, hf as u32);
    let mut pix = resvg::tiny_skia::Pixmap::new(w, h).ok_or_else(|| render_failed("the figure has no size"))?;
    pix.fill(resvg::tiny_skia::Color::WHITE);
    resvg::render(tree, resvg::tiny_skia::Transform::from_scale(s, s), &mut pix.as_mut());
    Ok(pix)
}

pub fn png(tree: &usvg::Tree, scale: u32) -> Result<Vec<u8>, QnError> {
    pixmap(tree, scale)?.encode_png().map_err(render_failed)
}

/// The figure's size in points.
pub fn point_size(tree: &usvg::Tree) -> (f64, f64) {
    (tree.size().width() as f64, tree.size().height() as f64)
}

/// The bytes for File ▸ Export ▸ Diagram as PDF… / PNG….
pub fn render(svg: &str, format: &str, scale: u32) -> Result<Vec<u8>, QnError> {
    let tree = parse(svg)?;
    match format {
        "pdf" => pdf(&tree),
        "png" => png(&tree, scale),
        other => Err(QnError::invalid(format!("“{other}” isn't a diagram format Qnet writes."))),
    }
}

/// Writes the file in place (0.90.34's `Data.write(to:)`, not atomic). A failure is `failed` with
/// the system's reason as the message; a render failure is `invalid`.
pub fn write(path: &Path, bytes: &[u8]) -> Result<String, QnError> {
    std::fs::write(path, bytes).map_err(|e| QnError::new(ErrorKind::Failed, e.to_string()))?;
    Ok(file_name(path))
}

/// File ▸ Export ▸ Diagram as PDF… / PNG…: renders `svg` and writes it to `path`; resolves to the
/// file name for "Exported diagram to <name>.".
#[tauri::command]
pub async fn diagram_export(svg: String, format: String, scale: u32, path: String) -> Result<String, QnError> {
    let bytes = render(&svg, &format, scale)?;
    write(Path::new(&path), &bytes)
}

/// Edit ▸ Copy as Image: a PDF of `pdf_svg` (its ground may be transparent) and a TIFF of
/// `image_svg` at `scale` on the general pasteboard.
#[tauri::command]
pub async fn diagram_copy(app: tauri::AppHandle, pdf_svg: String, image_svg: String, scale: u32) -> Result<(), QnError> {
    let pdf_bytes = pdf(&parse(&pdf_svg)?)?;
    let image = parse(&image_svg)?;
    let png_bytes = png(&image, scale)?;
    let size = point_size(&image);
    crate::canvas_native::on_main(&app, move || crate::canvas_native::copy(&pdf_bytes, &png_bytes, size))?
}

/// File ▸ Print Diagram…: the PDF page through the standard Print panel, scaled down (never up)
/// to the paper of the shared print info; resolves when the panel closes.
#[tauri::command]
pub async fn diagram_print(app: tauri::AppHandle, svg: String, job_title: String) -> Result<(), QnError> {
    let bytes = pdf(&parse(&svg)?)?;
    crate::canvas_native::on_main(&app, move || crate::canvas_native::print(&bytes, &job_title))?
}

/// File ▸ Page Setup…: `NSApp.runPageLayout(nil)`, which edits the shared print info Print reads.
#[tauri::command]
pub async fn diagram_page_setup(app: tauri::AppHandle) -> Result<(), QnError> {
    crate::canvas_native::on_main(&app, crate::canvas_native::page_setup)?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A figure as the interface sends one: a canvas ground, a node and its names in the CSS
    /// family list the page uses, at the weights the canvas draws (semibold name, regular detail).
    const FIGURE: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
<rect width="200" height="100" fill="#f6f6f8"/>
<circle cx="60" cy="40" r="22" fill="#d6e6fb" stroke="#3478f6" stroke-width="2"/>
<text x="60" y="80" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, &quot;SF Pro Text&quot;, system-ui, sans-serif" font-size="12" font-weight="600" fill="#1d1d1f">S1</text>
<text x="140" y="80" text-anchor="middle" font-family="-apple-system, sans-serif" font-size="10" fill="#6e6e73">μ = 1.11</text>
</svg>"##;

    fn base_fonts(pdf: &[u8]) -> Vec<String> {
        let text = String::from_utf8_lossy(pdf);
        let mut out = Vec::new();
        for part in text.split("/BaseFont/").skip(1) {
            let name: String = part.chars().take_while(|c| !matches!(c, '/' | ' ' | '>' | '[' | '\n')).collect();
            if !out.contains(&name) {
                out.push(name);
            }
        }
        out
    }

    #[test]
    fn the_system_font_answers_to_the_names_a_page_calls_it_by() {
        let db = fonts();
        let face = |family: &str| {
            db.query(&fontdb::Query { families: &[fontdb::Family::Name(family)], ..fontdb::Query::default() })
                .and_then(|id| db.face(id).map(|f| f.post_script_name.clone()))
        };
        if Path::new("/System/Library/Fonts/SFNS.ttf").exists() {
            for name in ["System Font", "-apple-system", "BlinkMacSystemFont", "system-ui", "SF Pro Text"] {
                assert_eq!(face(name).as_deref(), Some(".SFNS-Regular"), "{name}");
            }
            assert_eq!(default_family(), SYSTEM_FAMILY);
        } else {
            assert_eq!(default_family(), FALLBACK_FAMILY);
        }
    }

    #[test]
    fn a_pdf_is_one_page_the_size_of_the_figure_with_its_text_in_embedded_sf_pro() {
        let bytes = render(FIGURE, "pdf", 2).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.starts_with("%PDF-"));
        assert_eq!(text.matches("/Type/Page/").count() + text.matches("/Type /Page\n").count(), 1, "one page");
        assert!(text.contains("/MediaBox[0 0 200 100]"), "a 200 × 100 pt page");
        let fonts = base_fonts(&bytes);
        // Two weights of the variable font, each its own subset ("ABCDEF+.SFNS-Regular" is the
        // file's PostScript name; the semibold subset is instanced at wght 600).
        if Path::new("/System/Library/Fonts/SFNS.ttf").exists() {
            assert!(fonts.iter().all(|f| f.ends_with("+.SFNS-Regular")), "{fonts:?}");
            assert_eq!(fonts.len(), 2, "one subset per weight: {fonts:?}");
        } else {
            assert!(fonts.iter().all(|f| f.contains("HelveticaNeue")), "{fonts:?}");
        }
        assert!(text.contains("/FontFile2"), "the font is embedded");
        assert!(text.contains("/ToUnicode"), "the text stays text (searchable, copyable)");
    }

    #[test]
    fn a_png_is_the_figure_at_the_pixel_scale_opaque_with_the_drawing_on_it() {
        for scale in PIXEL_SCALES {
            let tree = parse(FIGURE).unwrap();
            let pix = pixmap(&tree, scale).unwrap();
            assert_eq!((pix.width(), pix.height()), (200 * scale, 100 * scale));
            assert!(pix.pixels().iter().all(|p| p.alpha() == 255), "opaque");
            let ground = pix.pixel(1, 1).unwrap();
            assert_eq!((ground.red(), ground.green(), ground.blue()), (0xf6, 0xf6, 0xf8));
            let drawn = pix.pixels().iter().filter(|p| (p.red(), p.green(), p.blue()) != (0xf6, 0xf6, 0xf8)).count();
            assert!(drawn > (200 * 100 * scale * scale) as usize / 50, "the node and its labels are drawn ({drawn} px)");
            let png = png(&tree, scale).unwrap();
            assert_eq!(&png[1..4], b"PNG");
        }
    }

    #[test]
    fn a_transparent_ground_becomes_white_in_a_png_and_text_has_ink() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="80" height="30"><text x="4" y="20" font-size="14" font-weight="600">S1 0.9</text></svg>"##;
        let pix = pixmap(&parse(svg).unwrap(), 1).unwrap();
        let p = pix.pixel(79, 29).unwrap();
        assert_eq!((p.red(), p.green(), p.blue(), p.alpha()), (255, 255, 255, 255));
        assert!(pix.pixels().iter().any(|p| p.red() < 100), "the text is drawn");
    }

    #[test]
    fn export_writes_the_file_and_names_it_and_refuses_what_it_cannot_render() {
        let dir = std::env::temp_dir().join(format!("qnet-diagram-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Network Diagram.png");
        let name = write(&path, &render(FIGURE, "png", 1).unwrap()).unwrap();
        assert_eq!(name, "Network Diagram.png");
        assert_eq!(&std::fs::read(&path).unwrap()[1..4], b"PNG");
        assert_eq!(render("<not svg", "pdf", 1).unwrap_err().kind, ErrorKind::Invalid);
        assert_eq!(render(FIGURE, "tiff", 1).unwrap_err().kind, ErrorKind::Invalid);
        assert_eq!(render(FIGURE, "png", 3).unwrap_err().kind, ErrorKind::Invalid);
        let e = write(&dir.join("no such folder").join("x.pdf"), b"%PDF").unwrap_err();
        assert_eq!(e.kind, ErrorKind::Failed);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
