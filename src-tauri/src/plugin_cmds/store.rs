//! 插件 store 布局、state.json 与包描述原语（D-split 自 plugin_cmds.rs；行为零变化）。
//!
//! 目录布局（packages/data/runtime/transactions + state.json）、`ensure_*` 入口、
//! 描述符扫描（scan/describe_source/copy_binary）与 Phase 8 进程监督路径解析
//! （resolve_executable / resolve_plugin_owned_path）都在这里。

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::manifest::{manifest_details, read_manifest};
use super::validation::{
    split_package_id, validate_plugin_id, validate_relative_path, validate_runtime_id,
};
use super::PluginError;
use crate::error::PylonError;
use crate::AppState;

const PACKAGES: &str = "packages";
const DATA: &str = "data";
const RUNTIME: &str = "runtime";
const TRANSACTIONS: &str = "transactions";
const STATE: &str = "state.json";
const MAX_PACKAGE_BYTES: u64 = 1024 * 1024 * 1024;

pub(crate) fn root<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, PluginError> {
    let dirs = app
        .state::<AppState>()
        .data_dirs_cloned()
        .map_err(PluginError::Io)?;
    Ok(crate::paths::plugin_root(&dirs))
}

/// Phase 8 process supervisor path resolution. All returned paths are
/// canonical and confined to the active package or the plugin-owned data /
/// runtime roots. Keeping this beside the package store prevents a second,
/// subtly different traversal policy from growing in the process layer.
pub(crate) fn resolve_executable<R: tauri::Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
    package_instance_id: Option<&str>,
    executable_id: &str,
) -> Result<PathBuf, PluginError> {
    validate_plugin_id(plugin_id)?;
    if executable_id.is_empty()
        || executable_id.len() > 128
        || !executable_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err(PluginError::ManifestInvalid(format!(
            "invalid executable id: {executable_id}"
        )));
    }
    let store = root(app)?;
    ensure_layout_at(&store)?;
    let state = read_state(&store)?;
    let package_id = match package_instance_id {
        Some(package_id) => {
            let owner = split_package_id(package_id)?;
            if owner != plugin_id {
                return Err(PluginError::ResourceInvalid(format!(
                    "package owner mismatch: {package_id}"
                )));
            }
            package_id
        }
        None => state
            .active_versions
            .get(plugin_id)
            .ok_or_else(|| PluginError::NotFound(format!("active package for {plugin_id}")))?,
    };
    let package_root = packages(&store).join(plugin_id).join(package_id);
    let manifest = read_manifest(&package_root)?;
    let platform = platform_key()?;
    let relative = manifest
        .get("executables")
        .and_then(|value| value.get(executable_id))
        .and_then(|value| value.get(&platform))
        .and_then(|value| value.as_str())
        .ok_or_else(|| {
            PluginError::ManifestInvalid(format!(
                "executable {executable_id} has no {platform} target"
            ))
        })?
        .trim_start_matches("./");
    validate_relative_path(relative)?;
    canonical_confined_file(&package_root, relative)
}

pub(crate) fn resolve_plugin_owned_path<R: tauri::Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
    runtime_instance_id: &str,
    package_instance_id: Option<&str>,
    namespace: &str,
    relative: &str,
) -> Result<PathBuf, PluginError> {
    validate_plugin_id(plugin_id)?;
    validate_runtime_id(runtime_instance_id)?;
    let relative = if relative.is_empty() { "." } else { relative };
    if relative != "." {
        validate_relative_path(relative)?;
    }
    let store = root(app)?;
    ensure_layout_at(&store)?;
    let base = match namespace {
        "package" => {
            let state = read_state(&store)?;
            let package_id = match package_instance_id {
                Some(package_id) => package_id,
                None => state.active_versions.get(plugin_id).ok_or_else(|| {
                    PluginError::NotFound(format!("active package for {plugin_id}"))
                })?,
            };
            packages(&store).join(plugin_id).join(package_id)
        }
        "data" => data(&store).join(plugin_id),
        "runtime" => runtime(&store).join(runtime_instance_id),
        _ => {
            return Err(PluginError::ResourceInvalid(format!(
                "unknown plugin path namespace: {namespace}"
            )))
        }
    };
    fs::create_dir_all(&base).map_err(|error| PluginError::Io(error.to_string()))?;
    let canonical_base = base
        .canonicalize()
        .map_err(|error| PluginError::Io(error.to_string()))?;
    let candidate = if relative == "." {
        canonical_base.clone()
    } else {
        base.join(relative)
    };
    if !candidate.exists() {
        fs::create_dir_all(&candidate).map_err(|error| PluginError::Io(error.to_string()))?;
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|error| PluginError::Io(error.to_string()))?;
    if !canonical.starts_with(&canonical_base) || !canonical.is_dir() {
        return Err(PluginError::ResourceInvalid(
            "plugin cwd escaped owner root".into(),
        ));
    }
    Ok(canonical)
}

fn canonical_confined_file(base: &Path, relative: &str) -> Result<PathBuf, PluginError> {
    let canonical_base = base
        .canonicalize()
        .map_err(|_| PluginError::NotFound(base.display().to_string()))?;
    let candidate = base.join(relative);
    let canonical = candidate
        .canonicalize()
        .map_err(|_| PluginError::NotFound(candidate.display().to_string()))?;
    if !canonical.starts_with(&canonical_base) || !canonical.is_file() {
        return Err(PluginError::ResourceInvalid(
            "executable escaped package root".into(),
        ));
    }
    Ok(canonical)
}

fn platform_key() -> Result<String, PluginError> {
    let os = match std::env::consts::OS {
        "windows" => "windows",
        "linux" => "linux",
        "macos" => "macos",
        value => {
            return Err(PluginError::ManifestInvalid(format!(
                "unsupported executable OS: {value}"
            )))
        }
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        value => {
            return Err(PluginError::ManifestInvalid(format!(
                "unsupported executable architecture: {value}"
            )))
        }
    };
    Ok(format!("{os}-{arch}"))
}

pub(crate) fn packages(root: &Path) -> PathBuf {
    root.join(PACKAGES)
}
pub(crate) fn data(root: &Path) -> PathBuf {
    root.join(DATA)
}
pub(crate) fn runtime(root: &Path) -> PathBuf {
    root.join(RUNTIME)
}
pub(crate) fn transactions(root: &Path) -> PathBuf {
    root.join(TRANSACTIONS)
}
pub(crate) fn state_path(root: &Path) -> PathBuf {
    root.join(STATE)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginStateFile {
    pub(crate) schema_version: u32,
    #[serde(default)]
    pub(crate) disabled: Vec<String>,
    #[serde(default)]
    pub(crate) active_versions: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) package_history: std::collections::BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub(crate) skin_bindings: std::collections::BTreeMap<String, serde_json::Value>,
}

impl Default for PluginStateFile {
    fn default() -> Self {
        Self {
            schema_version: 2,
            disabled: Vec::new(),
            active_versions: std::collections::BTreeMap::new(),
            package_history: std::collections::BTreeMap::new(),
            skin_bindings: std::collections::BTreeMap::new(),
        }
    }
}

pub(crate) fn read_state(root: &Path) -> Result<PluginStateFile, PluginError> {
    let path = state_path(root);
    if !path.exists() {
        return Ok(PluginStateFile::default());
    }
    let value: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&path)
            .map_err(|e| PluginError::Io(format!("read {}: {e}", path.display())))?,
    )
    .map_err(|e| PluginError::StateConflict(format!("invalid state.json: {e}")))?;
    let schema = value
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(1);
    if schema > 2 {
        return Err(PluginError::StateConflict(format!(
            "unsupported schemaVersion: {schema}"
        )));
    }
    let mut state: PluginStateFile = serde_json::from_value(value)
        .map_err(|e| PluginError::StateConflict(format!("invalid state.json: {e}")))?;
    state.schema_version = 2;
    state.disabled.sort();
    state.disabled.dedup();
    Ok(state)
}

pub(crate) fn write_state(root: &Path, state: &PluginStateFile) -> Result<(), PluginError> {
    let mut state = state.clone();
    state.schema_version = 2;
    state.disabled.sort();
    state.disabled.dedup();
    let json = serde_json::to_string_pretty(&state)
        .map_err(|e| PluginError::Io(format!("serialize state: {e}")))?;
    crate::agent_config::write_config_atomically(&state_path(root), &json)
        .map_err(|e| PluginError::Io(format!("write state: {e}")))
}

pub(crate) fn sorted_paths(dir: &Path) -> Result<Vec<PathBuf>, PluginError> {
    let mut paths = fs::read_dir(dir)
        .map_err(|e| PluginError::Io(format!("read {}: {e}", dir.display())))?
        .map(|entry| {
            entry
                .map(|e| e.path())
                .map_err(|e| PluginError::Io(e.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    paths.sort();
    Ok(paths)
}

pub(crate) fn hash_bytes(hash: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(0x100000001b3);
    }
}

/// 共享目录遍历：symlink / 非文件 / 相对路径 / 体积上限校验 + 文件清单。
/// `visit` 只在需要内容指纹时读盘（源目录与 staging 副本）；已安装包描述用
/// 空访问器，只做 `symlink_metadata`（#670）。
fn walk_files(
    dir: &Path,
    mut visit: impl FnMut(&Path, &str) -> Result<(), PluginError>,
) -> Result<(Vec<super::PluginFileMetadata>, u64), PluginError> {
    if !dir.is_dir() {
        return Err(PluginError::SourceInvalid(format!(
            "not a directory: {}",
            dir.display()
        )));
    }
    let mut files = Vec::new();
    let mut total = 0_u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        for path in sorted_paths(&current)? {
            let meta = fs::symlink_metadata(&path)
                .map_err(|e| PluginError::Io(format!("metadata {}: {e}", path.display())))?;
            if meta.file_type().is_symlink() {
                return Err(PluginError::SourceInvalid(format!(
                    "symlink rejected: {}",
                    path.display()
                )));
            }
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            if !meta.is_file() {
                return Err(PluginError::SourceInvalid(format!(
                    "non-file rejected: {}",
                    path.display()
                )));
            }
            total = total
                .checked_add(meta.len())
                .ok_or_else(|| PluginError::SourceInvalid("size overflow".into()))?;
            if total > MAX_PACKAGE_BYTES {
                return Err(PluginError::SourceInvalid(format!(
                    "package exceeds {MAX_PACKAGE_BYTES} bytes"
                )));
            }
            let relative = path
                .strip_prefix(dir)
                .map_err(|e| PluginError::Io(e.to_string()))?
                .to_str()
                .ok_or_else(|| PluginError::SourceInvalid("non-UTF-8 path".into()))?
                .replace('\\', "/");
            validate_relative_path(&relative)?;
            visit(&path, &relative)?;
            files.push(super::PluginFileMetadata {
                path: relative.clone(),
                size: meta.len(),
                mime: super::resource::mime(Path::new(&relative)).into(),
            });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok((files, total))
}

pub(crate) fn scan(dir: &Path) -> Result<(Vec<super::PluginFileMetadata>, u64, u64), PluginError> {
    let mut fingerprint = 0xcbf29ce484222325_u64;
    let (files, total) = walk_files(dir, |path, relative| {
        hash_bytes(&mut fingerprint, relative.as_bytes());
        let mut input = File::open(path).map_err(|e| PluginError::Io(e.to_string()))?;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = input
                .read(&mut buffer)
                .map_err(|e| PluginError::Io(e.to_string()))?;
            if read == 0 {
                break;
            }
            hash_bytes(&mut fingerprint, &buffer[..read]);
        }
        Ok(())
    })?;
    Ok((files, total, fingerprint))
}

/// 已安装包的文件清单与体积：只读元数据，不重算内容指纹（#670）。
pub(crate) fn scan_metadata(
    dir: &Path,
) -> Result<(Vec<super::PluginFileMetadata>, u64), PluginError> {
    walk_files(dir, |_, _| Ok(()))
}

pub(crate) fn describe_source(dir: &Path) -> Result<super::PluginPackageDescriptor, PluginError> {
    let (manifest, id, version, _) = manifest_details(dir)?;
    let (files, total_bytes, fingerprint) = scan(dir)?;
    Ok(super::PluginPackageDescriptor {
        package_instance_id: format!("{id}@{version}-{fingerprint:016x}"),
        plugin_id: id,
        version,
        manifest,
        files,
        total_bytes,
        active: false,
    })
}

pub(crate) fn copy_binary(source: &Path, target: &Path) -> Result<(), PluginError> {
    fs::create_dir_all(target).map_err(|e| PluginError::Io(e.to_string()))?;
    let mut stack = vec![(source.to_path_buf(), target.to_path_buf())];
    while let Some((from_dir, to_dir)) = stack.pop() {
        for from in sorted_paths(&from_dir)? {
            let meta = fs::symlink_metadata(&from).map_err(|e| PluginError::Io(e.to_string()))?;
            if meta.file_type().is_symlink() {
                return Err(PluginError::SourceInvalid(format!(
                    "symlink rejected: {}",
                    from.display()
                )));
            }
            let to = to_dir.join(
                from.file_name()
                    .ok_or_else(|| PluginError::SourceInvalid("missing filename".into()))?,
            );
            if meta.is_dir() {
                fs::create_dir_all(&to).map_err(|e| PluginError::Io(e.to_string()))?;
                stack.push((from, to));
            } else if meta.is_file() {
                let mut input = File::open(&from).map_err(|e| PluginError::Io(e.to_string()))?;
                let mut output = File::create(&to).map_err(|e| PluginError::Io(e.to_string()))?;
                std::io::copy(&mut input, &mut output)
                    .map_err(|e| PluginError::Io(e.to_string()))?;
                output
                    .sync_all()
                    .map_err(|e| PluginError::Io(e.to_string()))?;
            } else {
                return Err(PluginError::SourceInvalid(format!(
                    "non-file rejected: {}",
                    from.display()
                )));
            }
        }
    }
    Ok(())
}

pub(crate) fn ensure_layout_at(root: &Path) -> Result<(), PluginError> {
    fs::create_dir_all(root).map_err(|e| PluginError::Io(e.to_string()))?;
    for dir in [
        packages(root),
        data(root),
        runtime(root),
        transactions(root),
    ] {
        fs::create_dir_all(dir).map_err(|e| PluginError::Io(e.to_string()))?;
    }
    if !state_path(root).exists() {
        write_state(root, &PluginStateFile::default())?;
    }
    Ok(())
}

pub(crate) fn ensure_at(root: &Path) -> Result<(), PluginError> {
    ensure_layout_at(root)?;
    super::transaction::recover(root)?;
    Ok(())
}

pub(crate) fn ensure_plugin_dirs(app: &AppHandle) -> Result<(), PluginError> {
    let dirs = app
        .state::<AppState>()
        .data_dirs_cloned()
        .map_err(PluginError::Io)?;
    ensure_at(&crate::paths::plugin_root(&dirs))?;
    // Keep all consumers pinned to the paths module's package/data/runtime/transaction truth.
    for path in [
        crate::paths::plugin_packages_dir(&dirs),
        crate::paths::plugin_data_dir(&dirs),
        crate::paths::plugin_runtime_dir(&dirs),
        crate::paths::plugin_transactions_dir(&dirs),
    ] {
        if !path.is_dir() {
            return Err(PluginError::Io(format!(
                "plugin directory was not created: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn plugin_package_inspect(
    source_path: String,
) -> Result<super::PluginPackageDescriptor, PylonError> {
    let source = PathBuf::from(source_path);
    if !source.is_absolute() || !source.is_dir() {
        return Err(PluginError::SourceInvalid(
            "sourcePath must be an existing absolute directory".into(),
        )
        .into());
    }
    // #670：整包遍历 + 内容指纹是同步 IO，移出 reactor 线程（与写事务同标准）。
    Ok(
        tauri::async_runtime::spawn_blocking(move || describe_source(&source))
            .await
            .map_err(|error| PluginError::Io(format!("plugin inspect task failed: {error}")))??,
    )
}
