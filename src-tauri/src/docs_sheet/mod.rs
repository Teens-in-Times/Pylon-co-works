//! Docs Sheet 子 WebView 管理（#371）：离线文档站的应用内查看器。
//!
//! 与 Browser Sheet 共用 `add_child` 子 WebView 机制与其环境参数一致性约束
//! （#308：参数不一致 → 第二 WebView2 环境创建失败 → 不受控的空壳原生窗口盖住
//! 主区），但结构有意更简单：单 WebView、固定入口、无标签/缩放/Agent 面。
//! 文档站自带完整导航（VitePress navbar/sidebar/搜索），壳层只负责生命周期、
//! bounds/可见性同步与 前进/后退/刷新/回首页。外部 http(s) 链接 fail-closed
//! 取消——不进本 WebView、也不代开系统浏览器（后续如需「外链进 Browser Sheet」
//! 再立项，避免把两套浏览器语义耦合进壳层）。

pub(crate) mod cmds;
pub(crate) mod resource;

use serde::Serialize;
use std::sync::Mutex;
// Manager：open 经 `state::<AppState>()` 取 DataDirs（CC-14 子 WebView 挂跟包 UDF）。
use tauri::Manager;

pub(crate) const DOCS_WEBVIEW_LABEL: &str = "pylon-docs";
/// 文档站入口。`scheme://localhost` 形态照 `pylon-plugin://` 前端先例；
/// Windows 上 WebView2/wry 将其与 `http://pylon-docs.localhost` 归一（见
/// [`is_docs_url`] 两种形态都放行）。
pub(crate) const DOCS_INDEX_URL: &str = "pylon-docs://localhost/index.html";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DocsPhase {
    Idle,
    Starting,
    Ready,
    Error,
}

impl DocsPhase {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Error => "error",
        }
    }
}

/// 导航守卫：仅放行文档站自身。scheme 形态（`pylon-docs://localhost/...`）与
/// Windows 归一后的 host 形态（`http(s)://pylon-docs.localhost/...`）都收，
/// 不依赖 wry 对自定义 scheme 的归一细节；其余一律取消导航（fail-closed）。
pub(crate) fn is_docs_url(url: &url::Url) -> bool {
    if url.scheme() == "pylon-docs" {
        return true;
    }
    matches!(url.scheme(), "http" | "https") && url.host_str() == Some("pylon-docs.localhost")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocsSheetSnapshot {
    pub(crate) phase: String,
    pub(crate) error: Option<String>,
    /// 原生 WebView 是否可见；Sheet keep-alive / 模态覆盖层期间为 false。
    pub(crate) visible: bool,
}

pub(crate) struct DocsSheetManager {
    inner: Mutex<DocsInner>,
}

struct DocsInner {
    phase: DocsPhase,
    error: Option<String>,
    bounds: Option<crate::browser::BrowserBounds>,
    window: Option<tauri::Window>,
    app: Option<tauri::AppHandle>,
    /// Sheet 是否位于活动主区。子 WebView 是原生层，不能依赖父 DOM 隐藏。
    visible: bool,
    webview: Option<tauri::Webview>,
}

impl DocsSheetManager {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(DocsInner {
                phase: DocsPhase::Idle,
                error: None,
                bounds: None,
                window: None,
                app: None,
                visible: true,
                webview: None,
            }),
        }
    }

    /// setup 注入主窗口（子 WebView `add_child` 需要）。与 Browser host 同期调用。
    pub(crate) fn register_host(&self, window: tauri::Window, app: tauri::AppHandle) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.window = Some(window);
            inner.app = Some(app);
        }
    }

    pub(crate) fn snapshot(&self) -> Result<DocsSheetSnapshot, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(Self::build_snapshot(&inner))
    }

    fn build_snapshot(inner: &DocsInner) -> DocsSheetSnapshot {
        DocsSheetSnapshot {
            phase: inner.phase.as_str().to_string(),
            error: inner.error.clone(),
            visible: inner.visible,
        }
    }

    /// 首次调用创建入口 WebView；已存在时只更新 bounds，保持幂等（keep-alive 复活）。
    pub(crate) fn start(
        &self,
        bounds: crate::browser::BrowserBounds,
    ) -> Result<DocsSheetSnapshot, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.bounds = Some(bounds);
        if inner.webview.is_some() || inner.phase == DocsPhase::Starting {
            return Ok(Self::build_snapshot(&inner));
        }
        let window = match (&inner.window, &inner.app) {
            (Some(window), Some(_)) => window.clone(),
            _ => return Err("docs sheet host 未注册（setup 未注入主窗口）".to_string()),
        };
        let bounds = inner.bounds.expect("刚写入，必然存在");
        // CC-14：子 WebView 与主窗共用包内 WebView2 UDF（数据跟包语义）。
        // 必须在 phase 置 Starting 之前取——取失败提前返回，不留悬挂 Starting 态。
        let dirs = window
            .app_handle()
            .state::<crate::AppState>()
            .data_dirs_cloned()
            .map_err(|e| format!("docs sheet host 未初始化 data dirs: {e}"))?;
        inner.phase = DocsPhase::Starting;
        inner.error = None;

        let parsed = url::Url::parse(DOCS_INDEX_URL).map_err(|e| format!("入口 URL 非法: {e}"))?;
        let builder =
            tauri::WebviewBuilder::new(DOCS_WEBVIEW_LABEL, tauri::WebviewUrl::External(parsed))
                .data_directory(crate::paths::webview_user_data_dir(&dirs))
                .on_navigation(is_docs_url)
                // 文档站内的 target=_blank（GitHub 链接等）一律拒绝弹新窗；
                // on_navigation 已把同 WebView 内的外链导航取消，这里补弹窗路径。
                .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny);

        // 子 WebView 必须与宿主主 WebView 共用同一套 WebView2 环境参数（#308，
        // 详见 browser::open_tab_in 的注释）；本应用窗口固定带调试端口那一串。
        #[cfg(windows)]
        let builder = match crate::browser::host_additional_browser_args() {
            Some(args) => builder.additional_browser_args(&args),
            None => builder,
        };

        let position = tauri::LogicalPosition::new(bounds.x as f64, bounds.y as f64);
        let size = tauri::LogicalSize::new(bounds.width as f64, bounds.height as f64);
        match window.add_child(builder, position, size) {
            Ok(webview) => {
                if !inner.visible {
                    let _ = webview.hide();
                }
                inner.webview = Some(webview);
                inner.phase = DocsPhase::Ready;
            }
            Err(error) => {
                let message = format!("创建文档子 WebView 失败: {error}");
                inner.phase = DocsPhase::Error;
                inner.error = Some(message.clone());
                return Err(message);
            }
        }
        Ok(Self::build_snapshot(&inner))
    }

    pub(crate) fn set_bounds(&self, bounds: crate::browser::BrowserBounds) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.bounds = Some(bounds);
        let webview = inner
            .webview
            .as_ref()
            .ok_or_else(|| "文档 Sheet 未启动".to_string())?;
        let rect = tauri::Rect {
            position: tauri::Position::Logical(tauri::LogicalPosition::new(
                bounds.x as f64,
                bounds.y as f64,
            )),
            size: tauri::Size::Logical(tauri::LogicalSize::new(
                bounds.width as f64,
                bounds.height as f64,
            )),
        };
        webview
            .set_bounds(rect)
            .map_err(|e| format!("调整文档区域失败: {e}"))
    }

    /// 同步 keep-alive / 模态覆盖层的原生可见性（子 WebView 不随宿主 DOM display:none 隐藏）。
    pub(crate) fn set_visible(&self, visible: bool) -> Result<DocsSheetSnapshot, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.visible = visible;
        if let Some(webview) = inner.webview.as_ref() {
            if visible {
                webview
                    .show()
                    .map_err(|e| format!("显示文档 WebView 失败: {e}"))?;
            } else {
                webview
                    .hide()
                    .map_err(|e| format!("隐藏文档 WebView 失败: {e}"))?;
            }
        }
        Ok(Self::build_snapshot(&inner))
    }

    pub(crate) fn go_back(&self) -> Result<DocsSheetSnapshot, String> {
        self.eval("history.back()")
    }

    pub(crate) fn go_forward(&self) -> Result<DocsSheetSnapshot, String> {
        self.eval("history.forward()")
    }

    pub(crate) fn reload(&self) -> Result<DocsSheetSnapshot, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let webview = Self::active_webview(&inner)?;
        webview.reload().map_err(|e| format!("刷新失败: {e}"))?;
        Ok(Self::build_snapshot(&inner))
    }

    pub(crate) fn go_home(&self) -> Result<DocsSheetSnapshot, String> {
        let parsed = url::Url::parse(DOCS_INDEX_URL).map_err(|e| format!("入口 URL 非法: {e}"))?;
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let webview = Self::active_webview(&inner)?;
        webview
            .navigate(parsed)
            .map_err(|e| format!("导航失败: {e}"))?;
        Ok(Self::build_snapshot(&inner))
    }

    fn eval(&self, script: &str) -> Result<DocsSheetSnapshot, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let webview = Self::active_webview(&inner)?;
        webview.eval(script).map_err(|e| format!("执行失败: {e}"))?;
        Ok(Self::build_snapshot(&inner))
    }

    /// 关闭 Sheet：销毁子 WebView（WebView2 子进程随之回收）。对 idle 幂等。
    pub(crate) fn close(&self) -> Result<DocsSheetSnapshot, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(webview) = inner.webview.take() {
            let _ = webview.close();
        }
        inner.phase = DocsPhase::Idle;
        inner.error = None;
        inner.visible = true;
        Ok(Self::build_snapshot(&inner))
    }

    fn active_webview(inner: &DocsInner) -> Result<&tauri::Webview, String> {
        inner
            .webview
            .as_ref()
            .ok_or_else(|| "文档 Sheet 未启动".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_defaults_to_idle() {
        let manager = DocsSheetManager::new();
        let snapshot = manager.snapshot().unwrap();
        assert_eq!(snapshot.phase, "idle");
        assert_eq!(snapshot.error, None);
        assert!(snapshot.visible);
    }

    #[test]
    fn start_requires_registered_host() {
        let manager = DocsSheetManager::new();
        let error = manager
            .start(crate::browser::BrowserBounds {
                x: 0,
                y: 0,
                width: 100,
                height: 100,
            })
            .unwrap_err();
        assert!(error.contains("host 未注册"));
    }

    #[test]
    fn operations_before_start_report_not_started() {
        let manager = DocsSheetManager::new();
        assert!(manager
            .set_bounds(crate::browser::BrowserBounds {
                x: 0,
                y: 0,
                width: 1,
                height: 1
            })
            .unwrap_err()
            .contains("未启动"));
        assert!(manager.go_back().unwrap_err().contains("未启动"));
        assert!(manager.go_forward().unwrap_err().contains("未启动"));
        assert!(manager.reload().unwrap_err().contains("未启动"));
        assert!(manager.go_home().unwrap_err().contains("未启动"));
    }

    #[test]
    fn close_from_idle_is_idempotent_and_resets_visibility() {
        let manager = DocsSheetManager::new();
        let snapshot = manager.close().unwrap();
        assert_eq!(snapshot.phase, "idle");
        assert!(snapshot.visible);
    }

    #[test]
    fn url_guard_admits_only_docs_site() {
        for ok in [
            "pylon-docs://localhost/index.html",
            "pylon-docs://localhost/manual/release-package",
            "http://pylon-docs.localhost/index.html",
            "https://pylon-docs.localhost/manual/plugin-system-user",
        ] {
            assert!(is_docs_url(&url::Url::parse(ok).unwrap()), "{ok} 应放行");
        }
        for bad in [
            "https://example.com/page",
            "http://pylon-plugin.localhost/pkg/a.js",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "http://pylon-docs.localhost.evil.com/",
            "about:blank",
        ] {
            assert!(
                !is_docs_url(&url::Url::parse(bad).unwrap()),
                "{bad} 必须拒绝"
            );
        }
    }
}
