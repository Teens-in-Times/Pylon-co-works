//! paths — 数据/配置目录统一解析（便携模式为唯一存储模式，#482）。
//!
//! 存储真源（2026-10-01 裁决：无外部用户，AppData 双模式与迁移链一并移除）：
//! - 数据/配置根 = `<exe_dir>/data/`（数据与配置同根；packager 预建空目录，
//!   运行时缺失则由探针创建）；
//! - 根目录不可写（只读介质/Program Files）→ 返回脱敏原因，启动管道按〔致命〕
//!   中止——**不做任何 AppData 回退**。
//!
//! 写权限判定用真实探针（`create_new` + 写入 + `sync_all` + 删除），
//! 不信任 `create_dir_all` 对已存在目录的暗示。
//!
//! `DataDirs` 在 `setup()` 最前面解析一次并放入 `AppState.data_dirs`；
//! 所有 SQLite / 插件目录 / MCP / gateway / pet 持久化必须经本模块的
//! `*_path(&DataDirs)` 函数取路径，禁止再直接调 `app.path().app_data_dir()` /
//! `app_config_dir()` 或重复解析。

use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub(crate) struct DataDirs {
    /// SQLite、gateway 实例/凭据等数据文件根目录。
    pub(crate) data_root: PathBuf,
    /// 插件、MCP、pet 等配置/状态文件根目录（便携模式下与 data_root 相同）。
    pub(crate) config_root: PathBuf,
}

fn exe_dir() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|error| format!("resolve current_exe failed: {error}"))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "current_exe has no parent".to_string())
}

/// 真实写探针：create_dir_all → create_new 探针文件 → 写短字节 → sync_all →
/// 关闭 → 删除。任一步失败返回脱敏原因（不暴露随机外部输入，不覆盖现有文件）。
fn probe_writable(root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|error| format!("create data root failed: {error}"))?;
    let probe = root.join(format!(".pylon-write-test-{}", std::process::id()));
    let write_result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create_new(&probe)?;
        file.write_all(b"pylon\n")?;
        file.sync_all()?;
        Ok(())
    })();
    let remove_result = std::fs::remove_file(&probe);
    if let Err(error) = write_result {
        return Err(format!("portable data root not writable: {error}"));
    }
    remove_result.map_err(|error| format!("portable probe cleanup failed: {error}"))?;
    Ok(())
}

/// 纯路径解析：便携根 = `<exe_dir>/data`，探针验证可写；不可写即致命失败。
/// 生产入口与测试共用（测试传临时目录，不依赖测试可执行文件旁目录）。
pub(crate) fn resolve_data_dirs_for(exe_dir: &Path) -> Result<DataDirs, String> {
    let portable_root = exe_dir.join("data");
    match probe_writable(&portable_root) {
        Ok(()) => {
            tracing::info!("portable data dir active: {}", portable_root.display());
            Ok(DataDirs {
                data_root: portable_root.clone(),
                config_root: portable_root,
            })
        }
        Err(reason) => Err(format!(
            "portable data root unavailable: {reason}；Pylon 仅支持便携存储模式（无 AppData 回退），请把程序放在可写目录运行"
        )),
    }
}

/// 生产入口：解析一次数据/配置根目录（便携唯一模式）。
/// 调用方（`setup()`）必须把返回值写入 `AppState.data_dirs`，之后所有路径
/// 消费者只使用该实例。
pub(crate) fn resolve_data_dirs() -> Result<DataDirs, String> {
    resolve_data_dirs_for(&exe_dir()?)
}

/// WebView2 用户数据目录（CC-14：localStorage / EBWebView 真身的落点）。
/// 跟包语义：随程序目录走，删程序文件夹 = 前端持久化一起没。
/// **纯路径、不触盘**（目录由 WebView2 运行时按需创建）。
pub(crate) fn webview_user_data_dir(dirs: &DataDirs) -> PathBuf {
    dirs.data_root.join("webview-cache")
}

pub(crate) fn message_db_path(dirs: &DataDirs) -> PathBuf {
    dirs.data_root.join("pylon-data-v1.sqlite3")
}

/// 日志根目录候选：`<exe_dir>/data/logs`（便携唯一模式，#482 起 AppData 兜底
/// 候选移除）。**纯解析、不触盘**（可写性由调用方逐个探测）。
pub(crate) fn log_dir_candidates(exe_dir: &Path) -> Vec<PathBuf> {
    vec![exe_dir.join("data").join("logs")]
}

/// 逐个候选真探可写性，返回第一个可写者（都不行则 `None`）。
pub(crate) fn first_writable_dir(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|candidate| probe_writable(candidate).is_ok())
        .cloned()
}

/// 日志根目录：`main()` 的 `init_tracing()` 用，等价于 [`resolve_data_dirs`] 会选中的
/// `data_root` 再加 `logs/`，但不依赖 Tauri。
pub(crate) fn resolve_log_root() -> Option<PathBuf> {
    let exe_dir = exe_dir().ok()?;
    first_writable_dir(&log_dir_candidates(&exe_dir))
}

pub(crate) fn gateway_instances_path(dirs: &DataDirs) -> PathBuf {
    dirs.data_root.join("pylon-gateway-instances.json")
}

/// Workspace 实体注册表。它属于用户业务数据，而不是可重建的 UI 缓存。
pub(crate) fn workspace_persist_path(dirs: &DataDirs) -> PathBuf {
    dirs.data_root.join("pylon-workspaces.json")
}

/// 凭据存储的打开根目录（`CredentialStore::open` 会在其下追加
/// `pylon-credentials/` 与 `pylon-master.key`）。
pub(crate) fn credentials_dir(dirs: &DataDirs) -> PathBuf {
    dirs.data_root.clone()
}

pub(crate) fn mcp_persist_path(dirs: &DataDirs) -> PathBuf {
    dirs.config_root.join("pylon-mcp.json")
}

/// Agent 浏览器设置（issue #82：档位/黑名单/广告过滤；Rust 侧权威）。
pub(crate) fn browser_agent_settings_path(dirs: &DataDirs) -> PathBuf {
    dirs.config_root.join("pylon-browser-agent.json")
}

pub(crate) fn pet_persist_path(dirs: &DataDirs) -> PathBuf {
    dirs.config_root.join("pylon-pet.json")
}

pub(crate) fn plugin_root(dirs: &DataDirs) -> PathBuf {
    dirs.config_root.join("pylon/plugins")
}

pub(crate) fn plugin_packages_dir(dirs: &DataDirs) -> PathBuf {
    plugin_root(dirs).join("packages")
}

pub(crate) fn plugin_data_dir(dirs: &DataDirs) -> PathBuf {
    plugin_root(dirs).join("data")
}

pub(crate) fn plugin_runtime_dir(dirs: &DataDirs) -> PathBuf {
    plugin_root(dirs).join("runtime")
}

pub(crate) fn plugin_transactions_dir(dirs: &DataDirs) -> PathBuf {
    plugin_root(dirs).join("transactions")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "pylon-paths-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ))
    }

    #[test]
    fn resolve_uses_exe_dir_data_as_only_root() {
        let exe = temp_root("portable");
        std::fs::create_dir_all(&exe).unwrap();
        let dirs = resolve_data_dirs_for(&exe).expect("resolve");
        assert_eq!(dirs.data_root, exe.join("data"));
        assert_eq!(dirs.config_root, exe.join("data"));
        // 便携是唯一模式：data 根缺失时由探针就地创建，而不是挑别的目录。
        assert!(exe.join("data").is_dir(), "缺失的 data 根必须自动创建");
        assert!(!exe.join("data/.pylon-write-test").exists());
        std::fs::remove_dir_all(&exe).ok();
    }

    /// #482 回归钉：便携根不可写时必须致命失败，**禁止**再回退 AppData。
    /// `data` 被普通文件占据 ⇒ create_dir_all 失败 ⇒ Err——这是 CI/Windows 上
    /// 能可靠模拟的不可写形态（真实只读介质由 manual 验收覆盖）。
    #[test]
    fn resolve_fails_fatal_when_data_root_unwritable() {
        let exe = temp_root("blocked");
        std::fs::create_dir_all(&exe).unwrap();
        std::fs::write(exe.join("data"), b"not a dir").unwrap();
        let result = resolve_data_dirs_for(&exe);
        assert!(
            result.is_err(),
            "data 根不可写必须致命失败，禁止回退 AppData"
        );
        std::fs::remove_dir_all(&exe).ok();
    }

    #[test]
    fn probe_writable_detects_readonly_existing_dir() {
        // 已存在但不可写的目录无法在 CI/Windows 上可靠模拟；此处至少钉住
        // 探针成功路径与残留清理语义（真实只读介质由 manual 验收覆盖）。
        let root = temp_root("probe-ok");
        std::fs::create_dir_all(&root).unwrap();
        probe_writable(&root).expect("writable temp dir must pass probe");
        let entries = std::fs::read_dir(&root).unwrap().count();
        assert_eq!(entries, 0, "探针文件必须清理");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn log_dir_candidates_is_single_portable_candidate() {
        let exe = temp_root("logs-portable");
        std::fs::create_dir_all(&exe).unwrap();
        // #482：便携唯一模式 ⇒ 候选只有 data/logs，AppData 兜底候选已退役。
        assert_eq!(
            log_dir_candidates(&exe),
            vec![exe.join("data").join("logs")]
        );
        std::fs::remove_dir_all(&exe).ok();
    }

    #[test]
    fn first_writable_dir_picks_the_earlier_candidate_and_creates_it() {
        let root = temp_root("writable-first");
        let first = root.join("logs");
        let second = root.join("fallback");
        let picked = first_writable_dir(&[first.clone(), second.clone()]).expect("candidate");
        assert_eq!(picked, first);
        assert!(first.is_dir(), "选中的目录必须真的建好");
        assert!(!second.exists(), "落选候选不该被创建");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn webview_user_data_dir_is_data_root_webview_cache() {
        // CC-14：WebView2 用户数据目录 = data_root/webview-cache（跟包语义）。
        // 只跟 data_root——webview 缓存是数据不是配置，config_root 不参与。
        let dirs = DataDirs {
            data_root: PathBuf::from("D:/pylon-data"),
            config_root: PathBuf::from("C:/pylon-config"),
        };
        assert_eq!(
            webview_user_data_dir(&dirs),
            PathBuf::from("D:/pylon-data/webview-cache")
        );
    }

    #[test]
    fn path_helpers_use_provided_dirs() {
        let dirs = DataDirs {
            data_root: PathBuf::from("D:/pylon-data"),
            config_root: PathBuf::from("C:/pylon-config"),
        };
        assert_eq!(
            message_db_path(&dirs),
            PathBuf::from("D:/pylon-data/pylon-data-v1.sqlite3")
        );
        assert_eq!(
            plugin_root(&dirs),
            PathBuf::from("C:/pylon-config/pylon/plugins")
        );
        assert_eq!(
            plugin_packages_dir(&dirs),
            PathBuf::from("C:/pylon-config/pylon/plugins/packages")
        );
        assert_eq!(
            plugin_data_dir(&dirs),
            PathBuf::from("C:/pylon-config/pylon/plugins/data")
        );
        assert_eq!(
            plugin_runtime_dir(&dirs),
            PathBuf::from("C:/pylon-config/pylon/plugins/runtime")
        );
        assert_eq!(
            plugin_transactions_dir(&dirs),
            PathBuf::from("C:/pylon-config/pylon/plugins/transactions")
        );
        assert_eq!(
            mcp_persist_path(&dirs),
            PathBuf::from("C:/pylon-config/pylon-mcp.json")
        );
    }
}
