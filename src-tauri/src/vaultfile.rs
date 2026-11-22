//! `vaultfile://` protocol: serves images and attachments from the current vault only.
//! The frontend builds URLs with `convertFileSrc(absPath, 'vaultfile')`.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, UriSchemeContext, UriSchemeResponder};

use crate::vault::{vault_target, AppState};

pub const SCHEME: &str = "vaultfile";

/// Origin of the app's own pages, allowed to `fetch` vault files (export embeds images).
fn app_origin(app: &AppHandle) -> String {
    match &app.config().build.dev_url {
        Some(url) if tauri::is_dev() => url.origin().ascii_serialization(),
        _ => "tauri://localhost".to_string(),
    }
}

fn mime_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "tif" | "tiff" => "image/tiff",
        "heic" => "image/heic",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// The file a request names if it currently lies inside `vault`.
fn requested_file(vault: &Path, uri_path: &str) -> Result<PathBuf, StatusCode> {
    let encoded = uri_path.strip_prefix('/').unwrap_or(uri_path);
    let decoded = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let target = vault_target(vault, Path::new(decoded.as_ref())).map_err(|_| StatusCode::FORBIDDEN)?;
    match fs::metadata(&target) {
        Ok(meta) if meta.is_file() => Ok(target),
        _ => Err(StatusCode::NOT_FOUND),
    }
}

fn respond(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let builder = Response::builder()
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, app_origin(app))
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-cache")
        // An SVG opened directly must not run scripts.
        .header(header::CONTENT_SECURITY_POLICY, "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    let result = app
        .state::<AppState>()
        .current_vault()
        .ok_or(StatusCode::FORBIDDEN)
        .and_then(|vault| requested_file(&vault, request.uri().path()))
        .and_then(|path| {
            fs::read(&path)
                .map(|bytes| (mime_type(&path), bytes))
                .map_err(|_| StatusCode::NOT_FOUND)
        });
    let response = match result {
        Ok((mime, bytes)) => builder.header(header::CONTENT_TYPE, mime).body(bytes),
        Err(status) => builder.status(status).body(Vec::new()),
    };
    response.unwrap_or_else(|_| {
        let mut fallback = Response::new(Vec::new());
        *fallback.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
        fallback
    })
}

pub fn handle(ctx: UriSchemeContext<'_, tauri::Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || responder.respond(respond(&app, &request)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_only_files_inside_the_vault() {
        let base = std::env::temp_dir().join(format!("tasks-vaultfile-{}", std::process::id()));
        fs::create_dir_all(base.join("vault/attachments")).unwrap();
        fs::write(base.join("vault/attachments/a b.png"), "png").unwrap();
        fs::write(base.join("secret.png"), "secret").unwrap();
        let base = fs::canonicalize(&base).unwrap();
        let vault = base.join("vault");
        let url_path = |p: &Path| {
            let raw = p.to_string_lossy();
            format!("/{}", percent_encoding::utf8_percent_encode(&raw, percent_encoding::NON_ALPHANUMERIC))
        };

        let inside = vault.join("attachments/a b.png");
        assert_eq!(requested_file(&vault, &url_path(&inside)), Ok(inside));
        assert_eq!(
            requested_file(&vault, &url_path(&base.join("secret.png"))),
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            requested_file(&vault, &url_path(&vault.join("attachments/../../secret.png"))),
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            requested_file(&vault, &url_path(&vault.join("missing.png"))),
            Err(StatusCode::NOT_FOUND)
        );
        fs::remove_dir_all(&base).unwrap();
    }
}
