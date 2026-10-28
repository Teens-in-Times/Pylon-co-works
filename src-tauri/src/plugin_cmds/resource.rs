//! `pylon-plugin://` 资源协议：HTTP 响应（Range/缓存头）、MIME 判定与 URL
//! 编解码（D-split 自 plugin_cmds.rs；行为零变化）。

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::AppHandle;

use super::store::{packages, root};
use super::validation::{split_package_id, validate_relative_path, validate_runtime_id};
use super::PluginError;
use crate::error::PylonError;

const MAX_INVOKE_TEXT_BYTES: u64 = 8 * 1024 * 1024;

pub(crate) fn decode_component(value: &str) -> Result<String, PluginError> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(PluginError::ResourceInvalid("bad percent encoding".into()));
            }
            let pair = std::str::from_utf8(&bytes[index + 1..index + 3])
                .map_err(|_| PluginError::ResourceInvalid("bad percent encoding".into()))?;
            let byte = u8::from_str_radix(pair, 16)
                .map_err(|_| PluginError::ResourceInvalid("bad percent encoding".into()))?;
            if matches!(byte, b'/' | b'\\' | 0) {
                return Err(PluginError::ResourceInvalid(
                    "encoded separator rejected".into(),
                ));
            }
            decoded.push(byte);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| PluginError::ResourceInvalid("non-UTF-8 path".into()))
}

pub(crate) fn resolve_resource(
    root: &Path,
    package_id: &str,
    relative: &str,
) -> Result<PathBuf, PluginError> {
    let plugin_id = split_package_id(package_id)?;
    let relative = decode_component(relative)?;
    validate_relative_path(&relative).map_err(|e| PluginError::ResourceInvalid(e.to_string()))?;
    let package_root = packages(root).join(plugin_id).join(package_id);
    let canonical_root = package_root
        .canonicalize()
        .map_err(|_| PluginError::NotFound(package_id.into()))?;
    let candidate = package_root.join(relative);
    let canonical = candidate
        .canonicalize()
        .map_err(|_| PluginError::NotFound(candidate.display().to_string()))?;
    if !canonical.starts_with(canonical_root) || !canonical.is_file() {
        return Err(PluginError::ResourceInvalid(
            "resource escaped package root".into(),
        ));
    }
    Ok(canonical)
}

pub(crate) fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn error_response(status: StatusCode, value: impl ToString) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(value.to_string().into_bytes())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn parse_range(value: &str, length: u64) -> Result<(u64, u64), PluginError> {
    let value = value
        .strip_prefix("bytes=")
        .ok_or_else(|| PluginError::ResourceInvalid("unsupported range unit".into()))?;
    if value.contains(',') || length == 0 {
        return Err(PluginError::ResourceInvalid("unsupported range".into()));
    }
    let (start, end) = value
        .split_once('-')
        .ok_or_else(|| PluginError::ResourceInvalid("invalid range".into()))?;
    let (start, end) = if start.is_empty() {
        let count = end
            .parse::<u64>()
            .map_err(|_| PluginError::ResourceInvalid("invalid range".into()))?
            .min(length);
        (length - count, length - 1)
    } else {
        let start = start
            .parse::<u64>()
            .map_err(|_| PluginError::ResourceInvalid("invalid range".into()))?;
        let end = if end.is_empty() {
            length - 1
        } else {
            end.parse::<u64>()
                .map_err(|_| PluginError::ResourceInvalid("invalid range".into()))?
                .min(length - 1)
        };
        (start, end)
    };
    if start >= length || start > end {
        Err(PluginError::ResourceInvalid("range not satisfiable".into()))
    } else {
        Ok((start, end))
    }
}

pub(crate) fn resource_response_at(root: &Path, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = request.uri().path().trim_start_matches('/');
    let Some((package_id, relative)) = path.split_once('/') else {
        return error_response(StatusCode::BAD_REQUEST, "missing package/path");
    };
    let resource = match resolve_resource(root, package_id, relative) {
        Ok(path) => path,
        Err(PluginError::NotFound(e)) => return error_response(StatusCode::NOT_FOUND, e),
        Err(e) => return error_response(StatusCode::BAD_REQUEST, e),
    };
    let length = match resource.metadata() {
        Ok(v) => v.len(),
        Err(e) => return error_response(StatusCode::NOT_FOUND, e),
    };
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|v| parse_range(v, length));
    let (start, end, status) = match range {
        Some(Ok((start, end))) => (start, end, StatusCode::PARTIAL_CONTENT),
        Some(Err(e)) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{length}"))
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(e.to_string().into_bytes())
                .unwrap_or_else(|_| Response::new(Vec::new()))
        }
        None => (0, length.saturating_sub(1), StatusCode::OK),
    };
    let amount = if length == 0 { 0 } else { end - start + 1 };
    let mut file = match File::open(&resource) {
        Ok(v) => v,
        Err(e) => return error_response(StatusCode::NOT_FOUND, e),
    };
    if let Err(e) = file.seek(SeekFrom::Start(start)) {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    let mut body = Vec::with_capacity(amount.min(16 * 1024 * 1024) as usize);
    if let Err(e) = file.take(amount).read_to_end(&mut body) {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime(&resource))
        .header(header::CONTENT_LENGTH, body.len().to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .header("X-Content-Type-Options", "nosniff");
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{length}"),
        );
    }
    builder
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

pub(crate) fn plugin_resource_response(
    app: &AppHandle,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    root(app)
        .map(|root| resource_response_at(&root, request))
        .unwrap_or_else(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[tauri::command]
pub(crate) async fn plugin_package_read_text(
    app: AppHandle,
    package_instance_id: String,
    path: String,
) -> Result<String, PylonError> {
    let root = root(&app)?;
    // #676：canonicalize + 最多 8MB 的读是同步 IO，与 #657/#670 同口径移出 reactor。
    tauri::async_runtime::spawn_blocking(move || read_text_at(&root, &package_instance_id, &path))
        .await
        .map_err(|error| PluginError::Io(format!("plugin read task failed: {error}")))?
        .map_err(Into::into)
}

fn read_text_at(root: &Path, package_instance_id: &str, path: &str) -> Result<String, PluginError> {
    let resource = resolve_resource(root, package_instance_id, path)?;
    let size = resource
        .metadata()
        .map_err(|e| PluginError::Io(e.to_string()))?
        .len();
    if size > MAX_INVOKE_TEXT_BYTES {
        return Err(PluginError::ResourceInvalid(format!(
            "resource is {size} bytes; use resourceUrl/stream"
        )));
    }
    fs::read_to_string(resource)
        .map_err(|e| PluginError::ResourceInvalid(format!("not UTF-8: {e}")))
}

pub(crate) fn encode_component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'@') {
            output.push(char::from(byte));
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

#[tauri::command]
pub(crate) async fn plugin_package_resource_url(
    package_instance_id: String,
    path: String,
    runtime_instance_id: Option<String>,
) -> Result<String, PylonError> {
    split_package_id(&package_instance_id)?;
    validate_relative_path(&path)?;
    if let Some(id) = runtime_instance_id.as_deref() {
        validate_runtime_id(id)?;
    }
    let encoded = path
        .split('/')
        .map(encode_component)
        .collect::<Vec<_>>()
        .join("/");
    let mut url = format!("pylon-plugin://localhost/{package_instance_id}/{encoded}");
    if let Some(runtime) = runtime_instance_id {
        url.push_str("?runtime=");
        url.push_str(&encode_component(&runtime));
    }
    Ok(url)
}
