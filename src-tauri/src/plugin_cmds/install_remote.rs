//! zip / https URL 安装源（P53 D6；复用既有 stage/commit 事务与回滚）
//! （D-split 自 plugin_cmds.rs；行为零变化）。

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use super::store::{describe_source, ensure_layout_at, root};
use super::transaction::{install_at, write_lock};
use super::validation::validate_plugin_id;
use super::{PluginError, PluginPackageDescriptor, PluginPackageOperationResult};
use crate::error::PylonError;

/// 本机 zip 安装包大小上限。
pub(crate) const MAX_INSTALL_ZIP_BYTES: u64 = 64 * 1024 * 1024;
/// 解压后的总字节上限（zip bomb 防护）。
pub(crate) const MAX_INSTALL_EXTRACT_BYTES: u64 = 256 * 1024 * 1024;
/// URL 安装重定向上限（每次重定向后仍须 https）。
pub(crate) const INSTALL_MAX_REDIRECTS: usize = 5;
/// URL 下载总超时。
pub(crate) const INSTALL_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// URL 下载连接超时。
pub(crate) const INSTALL_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 进度事件节流粒度。
const INSTALL_PROGRESS_CHUNK: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PluginInstallProgress {
    pub plugin_id: String,
    pub stage: String,
    pub bytes_total: Option<u64>,
    pub bytes_done: u64,
}

/// 校验安装源 URL：仅 https（fail-closed）。
pub(crate) fn validate_install_url(raw: &str) -> Result<url::Url, PluginError> {
    let parsed = url::Url::parse(raw)
        .map_err(|_| PluginError::SourceInvalid(format!("invalid install url: {raw}")))?;
    if parsed.scheme() != "https" {
        return Err(PluginError::SourceInvalid(format!(
            "install url must use https, got '{}'",
            parsed.scheme()
        )));
    }
    if parsed.host_str().map(str::is_empty).unwrap_or(true) {
        return Err(PluginError::SourceInvalid(
            "install url missing host".into(),
        ));
    }
    Ok(parsed)
}

/// URL 重定向决策（纯函数，可单测）：限次且每次重定向后仍须 https。
/// reqwest 在每次 redirect 前把当前 URL push 进 previous，故 hops 实为
/// "已完成跳数 + 1"；`hops > INSTALL_MAX_REDIRECTS` 允许恰好 5 跳。
pub(crate) fn install_redirect_decision(hops: usize, scheme: &str) -> Result<(), &'static str> {
    if hops > INSTALL_MAX_REDIRECTS {
        return Err("too many redirects");
    }
    if scheme != "https" {
        return Err("redirect to non-https url");
    }
    Ok(())
}

/// URL 下载重定向策略：限次且每次重定向后仍须 https。
pub(crate) fn install_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        match install_redirect_decision(attempt.previous().len(), attempt.url().scheme()) {
            Ok(()) => attempt.follow(),
            Err(message) => attempt.error(message),
        }
    })
}

/// 解压插件 zip 到 dest：拒绝 zip-slip（路径穿越/绝对路径）、symlink entry 与
/// 超限（zip 体积 / 解压总量）。返回解压的文件数。
pub(crate) fn extract_zip_archive(
    zip_path: &Path,
    dest: &Path,
    max_zip_bytes: u64,
    max_extract_bytes: u64,
) -> Result<usize, PluginError> {
    let zip_meta = fs::metadata(zip_path)
        .map_err(|e| PluginError::SourceInvalid(format!("zip unreadable: {e}")))?;
    if zip_meta.len() > max_zip_bytes {
        return Err(PluginError::SourceInvalid(format!(
            "zip exceeds size limit: {} > {max_zip_bytes}",
            zip_meta.len()
        )));
    }
    let file = File::open(zip_path).map_err(|e| PluginError::Io(e.to_string()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| PluginError::SourceInvalid(format!("invalid zip: {e}")))?;
    fs::create_dir_all(dest).map_err(|e| PluginError::Io(e.to_string()))?;
    let mut extracted_bytes: u64 = 0;
    let mut extracted_files = 0usize;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| PluginError::SourceInvalid(format!("invalid zip entry: {e}")))?;
        if entry.is_symlink() {
            return Err(PluginError::SourceInvalid(
                "symlink rejected in plugin zip".into(),
            ));
        }
        let relative = entry.enclosed_name().ok_or_else(|| {
            PluginError::SourceInvalid(format!("unsafe zip entry path: {}", entry.name()))
        })?;
        let target = dest.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| PluginError::Io(e.to_string()))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| PluginError::Io(e.to_string()))?;
        }
        // zip bomb 防护（review P0-1）：中央目录的 uncompressed_size 可谎报，
        // 上限必须按 std::io::copy 的实际写入量计费——take(remaining+1) 硬限幅，
        // 超限即拒绝；并校验实际字节数与声明一致（CRC 之外的长度自洽）。
        let remaining = max_extract_bytes.saturating_sub(extracted_bytes);
        let mut limited = (&mut entry).take(remaining.saturating_add(1));
        let mut out = File::create(&target).map_err(|e| PluginError::Io(e.to_string()))?;
        let written =
            std::io::copy(&mut limited, &mut out).map_err(|e| PluginError::Io(e.to_string()))?;
        if written > remaining {
            return Err(PluginError::SourceInvalid(format!(
                "zip extraction exceeds limit: > {max_extract_bytes}"
            )));
        }
        if written != entry.size() {
            return Err(PluginError::SourceInvalid(
                "zip entry size mismatch (declared uncompressed_size is untrustworthy)".into(),
            ));
        }
        extracted_bytes = extracted_bytes.saturating_add(written);
        extracted_files += 1;
    }
    if extracted_files == 0 {
        return Err(PluginError::SourceInvalid("zip contains no files".into()));
    }
    if !dest.join(super::manifest::MANIFEST).is_file() {
        return Err(PluginError::SourceInvalid(format!(
            "zip missing {} at archive root",
            super::manifest::MANIFEST
        )));
    }
    Ok(extracted_files)
}

/// #657：`extract_zip_archive` 是纯同步磁盘 IO（最多 256 MiB 展开），
/// 在 async 命令里放到阻塞线程池执行，不占 async worker。
pub(crate) async fn extract_zip_off_thread(
    zip_path: PathBuf,
    dest: &Path,
) -> Result<(), PluginError> {
    let dest = dest.to_path_buf();
    tokio::task::spawn_blocking(move || {
        extract_zip_archive(
            &zip_path,
            &dest,
            MAX_INSTALL_ZIP_BYTES,
            MAX_INSTALL_EXTRACT_BYTES,
        )
    })
    .await
    .map_err(|error| PluginError::Io(format!("zip extraction task failed: {error}")))?
    .map(|_extracted_files| ())
}

pub(crate) fn unique_install_temp(prefix: &str) -> PathBuf {
    let unique = format!(
        "{prefix}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let dir = std::env::temp_dir().join(unique);
    // review P1-1：下载落盘（File::create）要求父目录存在，构造即创建
    fs::create_dir_all(&dir).ok();
    dir
}

fn emit_install_progress(
    app: &AppHandle,
    plugin_id: &str,
    stage: &str,
    bytes_total: Option<u64>,
    bytes_done: u64,
) {
    let _ = app.emit(
        "pylon:plugin-install-progress",
        PluginInstallProgress {
            plugin_id: plugin_id.to_string(),
            stage: stage.to_string(),
            bytes_total,
            bytes_done,
        },
    );
}

/// 下载 zip 到 dest：仅 https、限重定向、总超时/连接超时受限、
/// Content-Length 与流式累计双重大小上限；进度经 Tauri event。
pub(crate) async fn download_install_zip(
    app: &AppHandle,
    raw_url: &str,
    dest: &Path,
    plugin_id: &str,
) -> Result<(), PluginError> {
    let parsed = validate_install_url(raw_url)?;
    let client = reqwest::Client::builder()
        .connect_timeout(INSTALL_CONNECT_TIMEOUT)
        .timeout(INSTALL_DOWNLOAD_TIMEOUT)
        .redirect(install_redirect_policy())
        .build()
        .map_err(|e| PluginError::Io(e.to_string()))?;
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| PluginError::Io(format!("download failed: {e}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(PluginError::Io(format!("download failed: HTTP {status}")));
    }
    let bytes_total = response.content_length();
    if let Some(total) = bytes_total {
        if total > MAX_INSTALL_ZIP_BYTES {
            return Err(PluginError::SourceInvalid(format!(
                "download exceeds size limit: {total} > {MAX_INSTALL_ZIP_BYTES}"
            )));
        }
    }
    // #657：下载循环在 async 上下文里，落盘与 fsync 走 tokio::fs——std File 的
    // write_all/sync_all 会阻塞 worker（fsync 是几百毫秒量级的同步系统调用）。
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| PluginError::Io(e.to_string()))?;
    let mut stream = response;
    let mut bytes_done: u64 = 0;
    let mut next_progress = INSTALL_PROGRESS_CHUNK;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|e| PluginError::Io(format!("download failed: {e}")))?
    {
        bytes_done = bytes_done.saturating_add(chunk.len() as u64);
        if bytes_done > MAX_INSTALL_ZIP_BYTES {
            return Err(PluginError::SourceInvalid(format!(
                "download exceeds size limit: > {MAX_INSTALL_ZIP_BYTES}"
            )));
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| PluginError::Io(e.to_string()))?;
        if bytes_done >= next_progress {
            next_progress += INSTALL_PROGRESS_CHUNK;
            emit_install_progress(app, plugin_id, "downloading", bytes_total, bytes_done);
        }
    }
    file.sync_all()
        .await
        .map_err(|e| PluginError::Io(e.to_string()))?;
    emit_install_progress(app, plugin_id, "downloaded", Some(bytes_done), bytes_done);
    Ok(())
}

fn cleanup_install_temp(dir: &Path) {
    let _ = fs::remove_dir_all(dir);
}

async fn install_from_zip_source(
    app: AppHandle,
    zip_source: InstallZipSource<'_>,
    expected_id: &str,
) -> Result<PluginPackageOperationResult, PylonError> {
    validate_plugin_id(expected_id)?;
    let root = root(&app)?;
    ensure_layout_at(&root)?;
    // review P2-3：下载/解压在临时区完成（可达 120s），不持有全局写锁——
    // 锁只覆盖 install_at 事务本体，避免阻塞其它包事务命令。
    let work = unique_install_temp("pylon-plugin-install");
    let extract_dir = work.join("extracted");
    let result = async {
        match zip_source {
            InstallZipSource::LocalZip(zip_path) => {
                let zip_path = PathBuf::from(zip_path);
                if !zip_path.is_absolute() || !zip_path.is_file() {
                    return Err(PluginError::SourceInvalid(
                        "zipPath must be an existing absolute file".into(),
                    )
                    .into());
                }
                emit_install_progress(&app, expected_id, "extracting", None, 0);
                extract_zip_off_thread(zip_path, &extract_dir).await?;
                Ok(())
            }
            InstallZipSource::Url(url) => {
                let zip_download = work.join("package.zip");
                download_install_zip(&app, url, &zip_download, expected_id).await?;
                emit_install_progress(&app, expected_id, "extracting", None, 0);
                extract_zip_off_thread(zip_download, &extract_dir).await?;
                Ok(())
            }
        }
    }
    .await;
    if let Err(error) = result {
        cleanup_install_temp(&work);
        return Err(error);
    }
    emit_install_progress(&app, expected_id, "staging", None, 0);
    // 复用既有事务：install_at = stage_at + commit（失败 abort 回滚）
    let _guard = write_lock().await;
    let outcome = install_at(&root, &extract_dir, expected_id);
    cleanup_install_temp(&work);
    // review P2-1：committed 只在成功时发布；失败以命令错误返回
    if outcome.is_ok() {
        emit_install_progress(&app, expected_id, "committed", None, 0);
    }
    Ok(outcome?)
}

enum InstallZipSource<'a> {
    LocalZip(&'a str),
    Url(&'a str),
}

#[tauri::command]
pub(crate) async fn plugin_install_from_zip(
    app: AppHandle,
    zip_path: String,
    expected_id: String,
) -> Result<PluginPackageOperationResult, PylonError> {
    install_from_zip_source(app, InstallZipSource::LocalZip(&zip_path), &expected_id).await
}

#[tauri::command]
pub(crate) async fn plugin_install_from_url(
    app: AppHandle,
    url: String,
    expected_id: String,
) -> Result<PluginPackageOperationResult, PylonError> {
    install_from_zip_source(app, InstallZipSource::Url(&url), &expected_id).await
}

/// 只读：解析 zip 安装包的 descriptor（解压临时区 + describe_source，不落库）。
#[tauri::command]
pub(crate) async fn plugin_package_inspect_zip(
    zip_path: String,
) -> Result<PluginPackageDescriptor, PylonError> {
    let zip_path = PathBuf::from(&zip_path);
    if !zip_path.is_absolute() || !zip_path.is_file() {
        return Err(
            PluginError::SourceInvalid("zipPath must be an existing absolute file".into()).into(),
        );
    }
    let work = unique_install_temp("pylon-plugin-inspect");
    let extract_dir = work.join("extracted");
    let result: Result<PluginPackageDescriptor, PylonError> = async {
        extract_zip_off_thread(zip_path, &extract_dir).await?;
        // #670：整包哈希是同步 IO，移出 reactor 线程。
        tauri::async_runtime::spawn_blocking(move || describe_source(&extract_dir))
            .await
            .map_err(|error| PluginError::Io(format!("plugin inspect task failed: {error}")))?
            .map_err(Into::into)
    }
    .await;
    cleanup_install_temp(&work);
    result
}

/// 只读：下载 https zip 并解析 descriptor（不落库；限流/超时/重定向同安装）。
#[tauri::command]
pub(crate) async fn plugin_package_inspect_url(
    app: AppHandle,
    url: String,
) -> Result<PluginPackageDescriptor, PylonError> {
    let parsed = validate_install_url(&url)?;
    let work = unique_install_temp("pylon-plugin-inspect");
    let zip_download = work.join("package.zip");
    let extract_dir = work.join("extracted");
    let result: Result<PluginPackageDescriptor, PylonError> = async {
        let plugin_hint = format!("inspect:{}", parsed.host_str().unwrap_or("remote"));
        download_install_zip(&app, &url, &zip_download, &plugin_hint).await?;
        extract_zip_off_thread(zip_download.clone(), &extract_dir).await?;
        // #670：整包哈希是同步 IO，移出 reactor 线程。
        tauri::async_runtime::spawn_blocking(move || describe_source(&extract_dir))
            .await
            .map_err(|error| PluginError::Io(format!("plugin inspect task failed: {error}")))?
            .map_err(Into::into)
    }
    .await;
    cleanup_install_temp(&work);
    result
}
