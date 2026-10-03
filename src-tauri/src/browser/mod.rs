//! Browser Sheet 子 WebView 管理。
//!
//! 一个 Browser Sheet 拥有多个内部标签；每个标签对应一个 Tauri 子 WebView。活动标签
//! show，其他标签 hide，切换时不销毁页面状态。关闭最后标签回到 idle；关闭 Sheet 则销毁
//! 所有子 WebView。地址栏、window.open 与初始 URL 共用 http/https 白名单（仅额外允许
//! 内部初始化用 about:blank）。缩放属于 Browser Sheet，新标签继承当前值。

// #245：browser 家族归目录；bridge 保持对外可见（原 pub mod browser_bridge），
// 其余成员沿用原 crate 根私有 mod 的 crate 级可见（pub(crate)）。
pub(crate) mod agent;
pub(crate) mod agent_cmds;
pub mod bridge;
pub(crate) mod cmds;

use serde::Serialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

pub(crate) const BROWSER_WEBVIEW_LABEL_PREFIX: &str = "pylon-browser";
pub(crate) const BROWSER_INITIAL_URL: &str = "about:blank";
pub(crate) const BROWSER_DEFAULT_ZOOM_PERCENT: u16 = 90;
pub(crate) const BROWSER_MIN_ZOOM_PERCENT: u16 = 50;
pub(crate) const BROWSER_MAX_ZOOM_PERCENT: u16 = 200;

/// 统一 Browser Sheet 的“链接进内部新标签”语义。
///
/// Tauri 的 `on_new_window` 主要覆盖 `window.open`，而 WebView2 对普通锚点的
/// `target="_blank"` 在不同版本上触发路径并不完全一致。这个初始化脚本把锚点
/// 明确转成 `window.open`，再由下方的新窗口回调创建内部标签，不把链接丢给系统浏览器。
const LINK_TARGET_INTERCEPT_SCRIPT: &str = r#"
(() => {
  const marker = '__PYLON_BROWSER_LINK_BRIDGE__';
  if (window[marker]) return;
  window[marker] = true;
  document.addEventListener('click', event => {
    if (event.defaultPrevented || (typeof event.button === 'number' && event.button !== 0 && event.button !== 1)) return;
    const origin = event.target;
    const element = origin instanceof Element ? origin.closest('a[href]') : null;
    if (!element) return;
    const href = element.href;
    const target = element.getAttribute('target');
    const rawHref = (element.getAttribute('href') || '').trim();
    // Browser Sheet 的链接策略：普通 HTTP(S) 链接也进入内部新标签；
    // 只有显式 `_self` 或同文档 hash 跳转留在当前页面，避免误打断页内目录。
    let destination;
    try { destination = new URL(href, window.location.href); } catch (_) { return; }
    const sameDocument = rawHref.startsWith('#') || (destination.origin === window.location.origin
      && destination.pathname === window.location.pathname
      && destination.search === window.location.search
      && Boolean(destination.hash));
    const opensTab = (target || '').toLowerCase() !== '_self' && !sameDocument;
    if (!opensTab || !/^https?:$/i.test(destination.protocol) || element.hasAttribute('download')) return;
    event.preventDefault();
    event.stopPropagation();
    window.open(destination.href, '_blank', 'noopener');
  }, true);
})();
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BrowserPhase {
    Idle,
    Starting,
    Ready,
    Error,
}

impl BrowserPhase {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserTabSnapshot {
    pub(crate) id: u64,
    pub(crate) url: Option<String>,
    pub(crate) title: Option<String>,
}

/// 活动标签投影保留既有 instanceId/url/title 字段，同时公开完整标签集合。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserSnapshot {
    pub(crate) instance_id: u64,
    pub(crate) phase: String,
    pub(crate) url: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) error: Option<String>,
    pub(crate) zoom_percent: u16,
    pub(crate) active_tab_id: Option<u64>,
    pub(crate) tabs: Vec<BrowserTabSnapshot>,
    /// 原生子 WebView 是否处于可见态；非活动 Sheet keep-alive 时为 false。
    pub(crate) visible: bool,
}

#[derive(Debug, Clone, Copy, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserBounds {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) fn is_allowed_browser_url(url: &url::Url) -> bool {
    match url.scheme() {
        "http" | "https" => true,
        "about" => url.as_str() == BROWSER_INITIAL_URL,
        _ => false,
    }
}

/// 宿主窗口主 WebView 所用的 WebView2 附加浏览器参数（`tauri.conf.json` →
/// `app.windows[].additionalBrowserArgs`，本仓内即调试端口那一串）。
///
/// 子 WebView 必须带上同一串：WebView2 只允许**参数完全一致**的环境共享同一个
/// user data folder，否则 `CreateCoreWebView2EnvironmentWithOptions` 直接失败。
/// 交给 wry 默认参数（不含 tauri.conf 的值）就会与主 WebView 的环境不一致——见
/// `open_tab_in` 里那段「失败会留下空壳原生窗口」的说明。
///
/// 按窗口 label 取对应配置；取不到时退回第一条窗口配置（本应用单窗口），都没有就
/// 返回 `None`，调用方照旧不指定参数（宁可保持现状，也不凭空造一串参数）。
/// `pub(crate)`：Docs Sheet（#371）的子 WebView 受同一约束，共用本函数。
#[cfg(windows)]
pub(crate) fn host_additional_browser_args(window: &tauri::Window) -> Option<String> {
    use tauri::Manager;
    let config = window.app_handle().config();
    config
        .app
        .windows
        .iter()
        .find(|candidate| candidate.label == window.label())
        .or_else(|| config.app.windows.first())
        .and_then(|candidate| candidate.additional_browser_args.clone())
}

pub(crate) struct BrowserManager {
    inner: Mutex<BrowserInner>,
    /// 页面加载钩子（issue #82）：Agent 层在此失效 ref 注册表等 per-tab 状态。
    page_load_hooks: Mutex<Vec<crate::browser::agent::PageLoadHook>>,
}

struct BrowserInner {
    phase: BrowserPhase,
    error: Option<String>,
    zoom_percent: u16,
    tabs: Vec<BrowserTab>,
    active_tab_id: Option<u64>,
    next_tab_id: u64,
    bounds: Option<BrowserBounds>,
    window: Option<tauri::Window>,
    app: Option<tauri::AppHandle>,
    /// Sheet 生命周期闸门：关闭 Sheet 后，已排队的 new-window 回调不得复活标签。
    accept_new_windows: bool,
    /// Browser Sheet 是否位于活动主区。子 WebView 是原生层，不能依赖父 DOM 隐藏。
    visible: bool,
}

struct BrowserTab {
    id: u64,
    url: Option<String>,
    title: Option<String>,
    webview: tauri::Webview,
}

impl BrowserManager {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(BrowserInner {
                phase: BrowserPhase::Idle,
                error: None,
                zoom_percent: BROWSER_DEFAULT_ZOOM_PERCENT,
                tabs: Vec::new(),
                active_tab_id: None,
                next_tab_id: 0,
                bounds: None,
                window: None,
                app: None,
                accept_new_windows: false,
                visible: true,
            }),
            page_load_hooks: Mutex::new(Vec::new()),
        }
    }

    /// 注册页面加载钩子（tab 导航完成时以 tab_id 回调；失败静默）。
    pub(crate) fn register_page_load_hook(&self, hook: crate::browser::agent::PageLoadHook) {
        if let Ok(mut hooks) = self.page_load_hooks.lock() {
            hooks.push(hook);
        }
    }

    pub(crate) fn register_host(&self, window: tauri::Window, app: tauri::AppHandle) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.window = Some(window);
            inner.app = Some(app);
        }
    }

    pub(crate) fn snapshot(&self) -> Result<BrowserSnapshot, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(Self::build_snapshot(&inner))
    }

    fn build_snapshot(inner: &BrowserInner) -> BrowserSnapshot {
        let active = inner
            .active_tab_id
            .and_then(|id| inner.tabs.iter().find(|tab| tab.id == id));
        BrowserSnapshot {
            instance_id: active.map_or(0, |tab| tab.id),
            phase: inner.phase.as_str().to_string(),
            url: active.and_then(|tab| tab.url.clone()),
            title: active.and_then(|tab| tab.title.clone()),
            error: inner.error.clone(),
            zoom_percent: inner.zoom_percent,
            active_tab_id: inner.active_tab_id,
            tabs: inner
                .tabs
                .iter()
                .map(|tab| BrowserTabSnapshot {
                    id: tab.id,
                    url: tab.url.clone(),
                    title: tab.title.clone(),
                })
                .collect(),
            visible: inner.visible,
        }
    }

    fn emit_status(&self, inner: &BrowserInner) {
        if let Some(app) = inner.app.as_ref() {
            let _ = app.emit(
                crate::event_names::BROWSER_STATUS,
                Self::build_snapshot(inner),
            );
        }
    }

    pub(crate) fn emit_browser_error(&self, message: String) {
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        inner.error = Some(message);
        self.emit_status(&inner);
    }

    /// 首次启动创建一个空标签；已有标签时只更新宿主 bounds，保持幂等。
    pub(crate) fn start(
        self: &Arc<Self>,
        bounds: BrowserBounds,
    ) -> Result<BrowserSnapshot, String> {
        {
            let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
            inner.bounds = Some(bounds);
            inner.accept_new_windows = true;
            if !inner.tabs.is_empty() || inner.phase == BrowserPhase::Starting {
                return Ok(Self::build_snapshot(&inner));
            }
        }
        self.open_tab(BROWSER_INITIAL_URL)
    }

    pub(crate) fn new_tab(self: &Arc<Self>) -> Result<BrowserSnapshot, String> {
        self.open_tab(BROWSER_INITIAL_URL)
    }

    /// 创建并激活一个指定 URL 的内部标签。链接回调和 Agent open-tab 共用此路径，
    /// 避免“先建空标签、再异步导航”造成活动标签/地址事件短暂错位。
    pub(crate) fn open_tab(self: &Arc<Self>, initial_url: &str) -> Result<BrowserSnapshot, String> {
        self.open_tab_in(initial_url, true)
    }

    /// 后台标签（issue #82 P2）：创建但不切换活动标签、不抢走用户视野。
    pub(crate) fn open_tab_background(
        self: &Arc<Self>,
        initial_url: &str,
    ) -> Result<BrowserSnapshot, String> {
        self.open_tab_in(initial_url, false)
    }

    fn open_tab_in(
        self: &Arc<Self>,
        initial_url: &str,
        activate: bool,
    ) -> Result<BrowserSnapshot, String> {
        let parsed = url::Url::parse(initial_url).map_err(|e| format!("URL 非法: {e}"))?;
        if !is_allowed_browser_url(&parsed) {
            return Err(format!(
                "仅允许 http/https，收到 scheme={}",
                parsed.scheme()
            ));
        }

        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let window = match (&inner.window, &inner.app) {
            (Some(window), Some(_)) => window.clone(),
            _ => return Err("browser host 未注册（setup 未注入主窗口）".to_string()),
        };
        let bounds = inner
            .bounds
            .ok_or_else(|| "browser bounds 未注册（请先启动 Browser Sheet）".to_string())?;
        if !inner.accept_new_windows {
            return Err("浏览器会话已关闭（请先启动 Browser Sheet）".to_string());
        }
        inner.next_tab_id += 1;
        let tab_id = inner.next_tab_id;
        if inner.tabs.is_empty() {
            inner.phase = BrowserPhase::Starting;
        }
        inner.error = None;

        let page_this = self.clone();
        let new_window_this = self.clone();
        let new_window_app = inner
            .app
            .clone()
            .ok_or_else(|| "browser host 未注册（setup 未注入主窗口）".to_string())?;
        let builder = tauri::WebviewBuilder::new(
            format!("{BROWSER_WEBVIEW_LABEL_PREFIX}-{tab_id}"),
            tauri::WebviewUrl::External(parsed),
        )
        .initialization_script(LINK_TARGET_INTERCEPT_SCRIPT)
        .on_navigation(is_allowed_browser_url)
        .on_new_window(move |url, _features| {
            if is_allowed_browser_url(&url) {
                // WebView2 回调通常不在 UI 主线程；add_child 必须排队到主线程，
                // 否则 target=_blank 在部分系统上会被静默拒绝。
                let manager = new_window_this.clone();
                let requested = url.to_string();
                if let Err(error) = new_window_app.run_on_main_thread(move || {
                    if let Err(error) = manager.open_tab(&requested) {
                        tracing::warn!("browser 新窗口创建标签失败（{requested}）: {error}");
                        manager.emit_browser_error(format!("打开链接失败：{error}"));
                    }
                }) {
                    tracing::warn!("browser 新窗口调度失败（{url}）: {error}");
                    new_window_this.emit_browser_error(format!("打开链接失败：{error}"));
                }
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_page_load(move |webview, payload| {
            let url = payload.url().to_string();
            let _ = webview.eval_with_callback("document.title", {
                let this = page_this.clone();
                let url = url.clone();
                move |title| {
                    let title = title.trim_matches('"').trim().to_string();
                    this.note_page_load(tab_id, url.clone(), Some(title));
                }
            });
            page_this.note_page_load(tab_id, url, None);
        });

        // 子 WebView 必须与宿主主 WebView 共用同一套 WebView2 环境参数。
        // 不带这串就会退回 wry 的默认参数（`--disable-features=...`，不含 tauri.conf
        // 的 `additionalBrowserArgs`），而主 WebView 的环境带这些参数；WebView2 要求共享
        // 同一 user data folder 的环境参数完全一致，否则第二环境创建直接失败。失败时
        // Tauri 在 `Message::CreateWebview` 里只 `log::error!`，却照样返回一个 Webview
        // 句柄——那个宿主窗口既不受 set_bounds/set_visible 控制也不会被 close 销毁，
        // 会一直盖在原生窗口栈顶层吃掉主区的鼠标与滚轮事件。
        #[cfg(windows)]
        let builder = match host_additional_browser_args(&window) {
            Some(args) => builder.additional_browser_args(&args),
            None => builder,
        };

        let position = tauri::LogicalPosition::new(bounds.x as f64, bounds.y as f64);
        let size = tauri::LogicalSize::new(bounds.width as f64, bounds.height as f64);
        let webview = match window.add_child(builder, position, size) {
            Ok(webview) => webview,
            Err(error) => {
                let message = format!("创建浏览器子 WebView 失败: {error}");
                inner.phase = if inner.tabs.is_empty() {
                    BrowserPhase::Error
                } else {
                    BrowserPhase::Ready
                };
                inner.error = Some(message.clone());
                self.emit_status(&inner);
                return Err(message);
            }
        };
        if let Err(error) = webview.set_zoom(f64::from(inner.zoom_percent) / 100.0) {
            let _ = webview.close();
            let message = format!("设置浏览器初始缩放失败: {error}");
            inner.phase = if inner.tabs.is_empty() {
                BrowserPhase::Error
            } else {
                BrowserPhase::Ready
            };
            inner.error = Some(message.clone());
            self.emit_status(&inner);
            return Err(message);
        }
        if activate {
            if let Some(active) = inner
                .active_tab_id
                .and_then(|id| inner.tabs.iter().find(|tab| tab.id == id))
            {
                let _ = active.webview.hide();
            }
        }
        // add_child 创建的 WebView 默认可见；keep-alive 的非活动 Browser
        // 需要在原生层同步隐藏，不能只依赖宿主父节点的 display:none。
        // 后台标签无论 Sheet 可见性如何都保持隐藏。
        if !inner.visible || !activate {
            let _ = webview.hide();
        }
        inner.tabs.push(BrowserTab {
            id: tab_id,
            url: Some(initial_url.to_string()),
            title: None,
            webview,
        });
        if activate {
            inner.active_tab_id = Some(tab_id);
        }
        inner.phase = BrowserPhase::Ready;
        let snapshot = Self::build_snapshot(&inner);
        self.emit_status(&inner);
        Ok(snapshot)
    }

    pub(crate) fn note_page_load(&self, tab_id: u64, url: String, title: Option<String>) {
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        {
            let Some(tab) = inner.tabs.iter_mut().find(|tab| tab.id == tab_id) else {
                return;
            };
            tab.url = Some(url);
            if let Some(title) = title {
                if !title.is_empty() {
                    tab.title = Some(title);
                }
            }
        }
        if let Some(app) = inner.app.as_ref() {
            let tab = inner.tabs.iter().find(|tab| tab.id == tab_id);
            let _ = app.emit(
                crate::event_names::BROWSER_PAGE,
                serde_json::json!({
                    "tabId": tab_id,
                    "active": inner.active_tab_id == Some(tab_id),
                    "url": tab.and_then(|tab| tab.url.clone()),
                    "title": tab.and_then(|tab| tab.title.clone()),
                }),
            );
        }
        drop(inner);
        if let Ok(hooks) = self.page_load_hooks.lock() {
            for hook in hooks.iter() {
                hook(tab_id);
            }
        }
    }

    pub(crate) fn navigate(&self, url: &str) -> Result<BrowserSnapshot, String> {
        // 保持既有错误优先级：URL 校验先于会话状态检查（既有测试契约）。
        let parsed = url::Url::parse(url).map_err(|e| format!("URL 非法: {e}"))?;
        if !is_allowed_browser_url(&parsed) {
            return Err(format!(
                "仅允许 http/https，收到 scheme={}",
                parsed.scheme()
            ));
        }
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let active_id = inner
            .active_tab_id
            .ok_or_else(|| "浏览器未启动".to_string())?;
        drop(inner);
        self.navigate_on(active_id, url)
    }

    /// 定向导航（issue #82）：指定 tab 导航，不切换活动标签。
    pub(crate) fn navigate_on(&self, tab_id: u64, url: &str) -> Result<BrowserSnapshot, String> {
        let parsed = url::Url::parse(url).map_err(|e| format!("URL 非法: {e}"))?;
        if !is_allowed_browser_url(&parsed) {
            return Err(format!(
                "仅允许 http/https，收到 scheme={}",
                parsed.scheme()
            ));
        }
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let tab = inner
            .tabs
            .iter_mut()
            .find(|tab| tab.id == tab_id)
            .ok_or_else(|| format!("浏览器标签不存在：{tab_id}"))?;
        tab.url = Some(url.to_string());
        tab.webview
            .navigate(parsed)
            .map_err(|e| format!("导航失败: {e}"))?;
        Ok(Self::build_snapshot(&inner))
    }

    pub(crate) fn go_back(&self) -> Result<BrowserSnapshot, String> {
        self.eval("history.back()")
    }

    pub(crate) fn go_forward(&self) -> Result<BrowserSnapshot, String> {
        self.eval("history.forward()")
    }

    pub(crate) fn reload(&self) -> Result<BrowserSnapshot, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let webview = Self::active_webview(&inner)?.clone();
        webview.reload().map_err(|e| format!("刷新失败: {e}"))?;
        Ok(Self::build_snapshot(&inner))
    }

    fn eval(&self, js: &str) -> Result<BrowserSnapshot, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let webview = Self::active_webview(&inner)?.clone();
        webview.eval(js).map_err(|e| format!("执行失败: {e}"))?;
        Ok(Self::build_snapshot(&inner))
    }

    /// 读取当前活动页面的有限、脱敏快照，作为 Agent 浏览器接口的观察面。
    /// 不导出 cookie/localStorage；只返回地址、标题、正文前 20k 字符和前 100 个链接。
    pub(crate) async fn page_snapshot(&self) -> Result<Value, String> {
        self.eval_json(
            r#"(() => JSON.stringify({
              url: window.location.href,
              title: document.title || null,
              text: (document.body?.innerText || '').slice(0, 20000),
              links: Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map((element, index) => ({
                index,
                text: (element.innerText || element.getAttribute('aria-label') || '').trim().slice(0, 240),
                href: element.href,
                target: element.getAttribute('target') || null,
                download: element.hasAttribute('download'),
                downloadName: element.getAttribute('download') || null,
              })),
              scrollX: window.scrollX,
              scrollY: window.scrollY,
            }))()"#,
        )
        .await
    }

    /// Trigger a download only after an explicit caller action.  The host validates
    /// the URL and derives a conservative filename; it never forwards cookies,
    /// headers, or arbitrary JavaScript supplied by the caller.
    pub(crate) async fn download(
        &self,
        url: &str,
        filename: Option<String>,
    ) -> Result<Value, String> {
        let parsed = url::Url::parse(url).map_err(|e| format!("URL 非法: {e}"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("下载仅允许 http/https URL".to_string());
        }
        let safe_name = filename
            .as_deref()
            .map(str::trim)
            .filter(|name| {
                !name.is_empty() && !name.chars().any(|ch| matches!(ch, '/' | '\\' | '\0'))
            })
            .map(str::to_string)
            .or_else(|| {
                parsed
                    .path_segments()
                    .and_then(|mut segments| segments.next_back())
                    .filter(|name| !name.is_empty())
                    .map(|name| name.chars().take(160).collect::<String>())
            })
            .unwrap_or_else(|| "download".to_string());
        let url_json = serde_json::to_string(url).map_err(|e| e.to_string())?;
        let name_json = serde_json::to_string(&safe_name).map_err(|e| e.to_string())?;
        self.eval_json(&format!(
            r#"(() => {{
              const url = {url_json};
              const name = {name_json};
              const anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = name;
              anchor.rel = 'noopener';
              anchor.style.display = 'none';
              document.body.appendChild(anchor);
              anchor.click();
              anchor.remove();
              return JSON.stringify({{ ok: true, url, filename: name, status: 'started' }});
            }})()"#
        ))
        .await
    }

    /// 通过 CSS selector 或可见文本触发页面元素 click。
    pub(crate) async fn click(
        self: &Arc<Self>,
        selector: Option<String>,
        text: Option<String>,
    ) -> Result<Value, String> {
        let selector = serde_json::to_string(&selector).map_err(|e| e.to_string())?;
        let text = serde_json::to_string(&text).map_err(|e| e.to_string())?;
        let result = self.eval_json(&format!(
            r#"(() => {{
              const selector = {selector};
              const needle = ({text} || '').trim().toLowerCase();
              const candidates = Array.from(document.querySelectorAll('a,button,[role="button"],input,textarea,[contenteditable="true"]'));
              let element = null;
              if (selector) {{
                try {{ element = document.querySelector(selector); }} catch (_) {{
                  return JSON.stringify({{ ok: false, code: 'invalid_selector' }});
                }}
              }}
              element = element
                || (needle ? candidates.find(value => (value.innerText || value.getAttribute('aria-label') || value.value || '').trim().toLowerCase().includes(needle)) : null);
              if (!element) return JSON.stringify({{ ok: false, code: 'element_not_found' }});
              element.scrollIntoView({{ block: 'center', inline: 'nearest' }});
              // Synthetic element.click() 不一定具备 user gesture，window.open 可能被
              // popup blocker 吞掉。把普通 HTTP(S) 锚点交给 Rust manager 直接开内部标签；
              // 非链接或显式当前页/同文档跳转仍保留页面自身 click 语义。
              if (element.matches('a[href]')) {{
                let destination;
                try {{ destination = new URL(element.href, window.location.href); }} catch (_) {{ destination = null; }}
                const rawHref = (element.getAttribute('href') || '').trim();
                const sameDocument = rawHref.startsWith('#') || (destination
                  && destination.origin === window.location.origin
                  && destination.pathname === window.location.pathname
                  && destination.search === window.location.search
                  && Boolean(destination.hash));
                const opensTab = destination
                  && (element.getAttribute('target') || '').toLowerCase() !== '_self'
                  && !sameDocument
                  && /^https?:$/i.test(destination.protocol)
                  && !element.hasAttribute('download');
                if (opensTab) return JSON.stringify({{ ok: true, tag: 'a', text: (element.innerText || element.getAttribute('aria-label') || '').trim().slice(0, 240), href: destination.href, opensTab: true }});
              }}
              element.click();
              return JSON.stringify({{ ok: true, tag: element.tagName.toLowerCase(), text: (element.innerText || element.getAttribute('aria-label') || '').trim().slice(0, 240), opensTab: false }});
            }})()"#,
            selector = selector,
            text = text,
        ))
        .await?;
        if result.get("opensTab").and_then(Value::as_bool) == Some(true) {
            let href = result
                .get("href")
                .and_then(Value::as_str)
                .ok_or_else(|| "链接缺少有效 URL".to_string())?;
            let snapshot = self.open_tab(href)?;
            return Ok(serde_json::json!({
                "ok": true,
                "tag": "a",
                "text": result.get("text").cloned().unwrap_or(Value::Null),
                "href": href,
                "openedTab": true,
                "browser": snapshot,
            }));
        }
        Ok(result)
    }

    /// 向当前焦点输入控件写入文本，并派发 input/change 事件。
    pub(crate) async fn type_text(
        &self,
        text: String,
        selector: Option<String>,
    ) -> Result<Value, String> {
        let text = serde_json::to_string(&text).map_err(|e| e.to_string())?;
        let selector = serde_json::to_string(&selector).map_err(|e| e.to_string())?;
        self.eval_json(&format!(
            r#"(() => {{
              const value = {text};
              const selector = {selector};
              const element = (selector ? document.querySelector(selector) : null) || document.activeElement;
              if (!element || !('value' in element || element.isContentEditable)) return JSON.stringify({{ ok: false, code: 'input_not_found' }});
              if (element.isContentEditable) element.textContent = value;
              else {{
                const prototype = Object.getPrototypeOf(element);
                const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
                if (setter) setter.call(element, value); else element.value = value;
              }}
              element.dispatchEvent(new Event('input', {{ bubbles: true }}));
              element.dispatchEvent(new Event('change', {{ bubbles: true }}));
              return JSON.stringify({{ ok: true }});
            }})()"#,
            text = text,
            selector = selector,
        ))
        .await
    }

    /// 向当前焦点元素派发 keydown/keyup；页面框架可按正常键盘事件处理。
    pub(crate) async fn press(&self, key: String) -> Result<Value, String> {
        let key = serde_json::to_string(&key).map_err(|e| e.to_string())?;
        self.eval_json(&format!(
            r#"(() => {{
              const key = {key};
              const target = document.activeElement || document.body;
              if (!target) return JSON.stringify({{ ok: false, code: 'document_not_ready' }});
              target.dispatchEvent(new KeyboardEvent('keydown', {{ key, bubbles: true, cancelable: true }}));
              target.dispatchEvent(new KeyboardEvent('keyup', {{ key, bubbles: true, cancelable: true }}));
              return JSON.stringify({{ ok: true, key }});
            }})()"#,
            key = key,
        ))
        .await
    }

    /// 滚动活动页面，返回滚动后的坐标。
    pub(crate) async fn scroll(&self, delta_x: i32, delta_y: i32) -> Result<Value, String> {
        self.eval_json(&format!(
            r#"(() => {{ window.scrollBy({delta_x}, {delta_y}); return JSON.stringify({{ ok: true, scrollX: window.scrollX, scrollY: window.scrollY }}); }})()"#,
            delta_x = delta_x,
            delta_y = delta_y,
        ))
        .await
    }

    async fn eval_json(&self, script: &str) -> Result<Value, String> {
        self.eval_json_on(None, script).await
    }

    /// 在指定标签（缺省活动标签）执行返回 `JSON.stringify(...)` 的脚本。
    pub(crate) async fn eval_json_on(
        &self,
        tab_id: Option<u64>,
        script: &str,
    ) -> Result<Value, String> {
        let webview = {
            let inner = self.inner.lock().map_err(|e| e.to_string())?;
            Self::webview_for(&inner, tab_id)?.webview.clone()
        };
        let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
        // Tauri 的 callback trait 是 `Fn`（理论上可能被调用多次），而 oneshot
        // sender 只能消费一次；用一次性槽位保持 callback 可重复调用且不 panic。
        let sender = Arc::new(Mutex::new(Some(sender)));
        let sender_callback = sender.clone();
        webview
            .eval_with_callback(script.to_string(), move |raw| {
                if let Ok(mut slot) = sender_callback.lock() {
                    if let Some(sender) = slot.take() {
                        let _ = sender.send(raw);
                    }
                }
            })
            .map_err(|e| format!("执行页面脚本失败: {e}"))?;
        let raw = tokio::time::timeout(Duration::from_secs(5), receiver)
            .await
            .map_err(|_| "页面脚本响应超时".to_string())
            .and_then(|result| result.map_err(|_| "页面脚本响应通道已关闭".to_string()))?;
        let encoded: Value =
            serde_json::from_str(&raw).map_err(|e| format!("页面脚本返回值非法: {e}"))?;
        if let Value::String(value) = encoded {
            serde_json::from_str(&value).map_err(|e| format!("页面脚本 JSON 非法: {e}"))
        } else {
            Ok(encoded)
        }
    }

    /// 解析目标标签句柄（issue #82）：`None` = 活动标签；`Some` 必须存在。
    pub(crate) fn tab_webview(&self, tab_id: Option<u64>) -> Result<(u64, tauri::Webview), String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let tab = Self::webview_for(&inner, tab_id)?;
        Ok((tab.id, tab.webview.clone()))
    }

    pub(crate) fn set_zoom(&self, zoom_percent: u16) -> Result<BrowserSnapshot, String> {
        if !(BROWSER_MIN_ZOOM_PERCENT..=BROWSER_MAX_ZOOM_PERCENT).contains(&zoom_percent) {
            return Err(format!(
                "浏览器缩放必须在 {BROWSER_MIN_ZOOM_PERCENT}%–{BROWSER_MAX_ZOOM_PERCENT}% 之间"
            ));
        }
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner.tabs.is_empty() {
            return Err("浏览器未启动".to_string());
        }
        for tab in &inner.tabs {
            tab.webview
                .set_zoom(f64::from(zoom_percent) / 100.0)
                .map_err(|e| format!("设置浏览器缩放失败: {e}"))?;
        }
        inner.zoom_percent = zoom_percent;
        let snapshot = Self::build_snapshot(&inner);
        self.emit_status(&inner);
        Ok(snapshot)
    }

    pub(crate) fn set_bounds(&self, bounds: BrowserBounds) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.bounds = Some(bounds);
        if inner.tabs.is_empty() {
            return Err("浏览器未启动".to_string());
        }
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
        for tab in &inner.tabs {
            tab.webview
                .set_bounds(rect)
                .map_err(|e| format!("调整浏览器区域失败: {e}"))?;
        }
        Ok(())
    }

    pub(crate) fn select_tab(&self, tab_id: u64) -> Result<BrowserSnapshot, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner.active_tab_id == Some(tab_id) {
            return Ok(Self::build_snapshot(&inner));
        }
        let next = inner
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .ok_or_else(|| format!("浏览器标签不存在：{tab_id}"))?
            .webview
            .clone();
        let current = inner.active_tab_id.and_then(|id| {
            inner
                .tabs
                .iter()
                .find(|tab| tab.id == id)
                .map(|tab| tab.webview.clone())
        });
        if let Some(current) = current.as_ref() {
            current
                .hide()
                .map_err(|e| format!("隐藏浏览器标签失败: {e}"))?;
        }
        if inner.visible {
            if let Err(error) = next.show() {
                if let Some(current) = current {
                    let _ = current.show();
                }
                return Err(format!("显示浏览器标签失败: {error}"));
            }
        }
        inner.active_tab_id = Some(tab_id);
        inner.error = None;
        let snapshot = Self::build_snapshot(&inner);
        self.emit_status(&inner);
        Ok(snapshot)
    }

    pub(crate) fn close_tab(&self, tab_id: u64) -> Result<BrowserSnapshot, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let index = inner
            .tabs
            .iter()
            .position(|tab| tab.id == tab_id)
            .ok_or_else(|| format!("浏览器标签不存在：{tab_id}"))?;
        let was_active = inner.active_tab_id == Some(tab_id);
        let removed = inner.tabs.remove(index);
        let _ = removed.webview.close();
        if was_active {
            if inner.tabs.is_empty() {
                inner.active_tab_id = None;
                inner.phase = BrowserPhase::Idle;
            } else {
                let next_index = index.min(inner.tabs.len() - 1);
                let next = &inner.tabs[next_index];
                if inner.visible {
                    next.webview
                        .show()
                        .map_err(|e| format!("显示浏览器标签失败: {e}"))?;
                } else {
                    let _ = next.webview.hide();
                }
                inner.active_tab_id = Some(next.id);
                inner.phase = BrowserPhase::Ready;
            }
        }
        inner.error = None;
        let snapshot = Self::build_snapshot(&inner);
        self.emit_status(&inner);
        Ok(snapshot)
    }

    /// 关闭 Browser Workspace：销毁全部内部标签及其 WebView2 子进程。
    pub(crate) fn close(&self) -> Result<BrowserSnapshot, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        for tab in inner.tabs.drain(..) {
            let _ = tab.webview.close();
        }
        inner.accept_new_windows = false;
        inner.bounds = None;
        inner.visible = true;
        inner.phase = BrowserPhase::Idle;
        inner.active_tab_id = None;
        inner.error = None;
        let snapshot = Self::build_snapshot(&inner);
        self.emit_status(&inner);
        Ok(snapshot)
    }

    /// 将所有标签切换到活动/隐藏状态。这个命令专门服务于 Browser Sheet
    /// keep-alive：原生子 WebView 不会随宿主 DOM 的 display:none 自动隐藏。
    pub(crate) fn set_visible(&self, visible: bool) -> Result<BrowserSnapshot, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.visible = visible;
        let active_id = inner.active_tab_id;
        for tab in &inner.tabs {
            if visible && Some(tab.id) == active_id {
                tab.webview
                    .show()
                    .map_err(|e| format!("显示浏览器标签失败: {e}"))?;
            } else {
                // 隐藏失败不应留下半可见的标签集合；与 select_tab 保持同一错误语义。
                tab.webview
                    .hide()
                    .map_err(|e| format!("隐藏浏览器标签失败: {e}"))?;
            }
        }
        let snapshot = Self::build_snapshot(&inner);
        self.emit_status(&inner);
        Ok(snapshot)
    }

    fn active_webview(inner: &BrowserInner) -> Result<&tauri::Webview, String> {
        let active_id = inner
            .active_tab_id
            .ok_or_else(|| "浏览器未启动".to_string())?;
        inner
            .tabs
            .iter()
            .find(|tab| tab.id == active_id)
            .map(|tab| &tab.webview)
            .ok_or_else(|| "浏览器未启动".to_string())
    }

    /// tab 寻址解析：`Some` 校验存在性；`None` 回落活动标签。
    fn webview_for(inner: &BrowserInner, tab_id: Option<u64>) -> Result<&BrowserTab, String> {
        match tab_id {
            Some(id) => inner
                .tabs
                .iter()
                .find(|tab| tab.id == id)
                .ok_or_else(|| format!("浏览器标签不存在：{id}")),
            None => {
                let active_id = inner
                    .active_tab_id
                    .ok_or_else(|| "浏览器未启动".to_string())?;
                inner
                    .tabs
                    .iter()
                    .find(|tab| tab.id == active_id)
                    .ok_or_else(|| "浏览器未启动".to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_defaults_to_idle_with_no_tabs() {
        let manager = BrowserManager::new();
        let snap = manager.snapshot().unwrap();
        assert_eq!(snap.phase, "idle");
        assert_eq!(snap.instance_id, 0);
        assert_eq!(snap.url, None);
        assert_eq!(snap.zoom_percent, BROWSER_DEFAULT_ZOOM_PERCENT);
        assert_eq!(snap.active_tab_id, None);
        assert!(snap.tabs.is_empty());
    }

    #[test]
    fn start_requires_registered_host() {
        let manager = Arc::new(BrowserManager::new());
        let err = manager
            .start(BrowserBounds {
                x: 0,
                y: 0,
                width: 100,
                height: 100,
            })
            .unwrap_err();
        assert!(err.contains("host 未注册"));
    }

    #[test]
    fn new_tab_requires_registered_host() {
        let manager = Arc::new(BrowserManager::new());
        assert!(manager.new_tab().unwrap_err().contains("host 未注册"));
    }

    #[test]
    fn url_whitelist_allows_http_https_and_init_about_blank() {
        for raw in ["https://example.com", "http://example.com", "about:blank"] {
            assert!(is_allowed_browser_url(&url::Url::parse(raw).unwrap()));
        }
        for raw in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "devtools://devtools/bundled/inspector.html",
            "chrome://settings",
            "about:config",
        ] {
            assert!(!is_allowed_browser_url(&url::Url::parse(raw).unwrap()));
        }
    }

    #[test]
    fn navigate_rejects_non_http_scheme() {
        let manager = BrowserManager::new();
        assert!(manager
            .navigate("file:///etc/passwd")
            .unwrap_err()
            .contains("仅允许 http/https"));
        assert!(manager
            .navigate("not-a-url")
            .unwrap_err()
            .contains("URL 非法"));
    }

    #[test]
    fn navigate_before_start_reports_not_started() {
        let manager = BrowserManager::new();
        assert!(manager
            .navigate("https://example.com")
            .unwrap_err()
            .contains("浏览器未启动"));
    }

    #[test]
    fn close_from_idle_is_ok_and_stays_idle() {
        let manager = BrowserManager::new();
        let snap = manager.close().unwrap();
        assert_eq!(snap.phase, "idle");
        assert!(snap.tabs.is_empty());
    }

    #[test]
    fn set_bounds_before_start_reports_not_started_but_remembers_bounds() {
        let manager = BrowserManager::new();
        let err = manager
            .set_bounds(BrowserBounds {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            })
            .unwrap_err();
        assert!(err.contains("浏览器未启动"));
    }

    #[test]
    fn zoom_rejects_out_of_range_before_webview_access() {
        let manager = BrowserManager::new();
        for zoom in [49, 201] {
            assert!(manager.set_zoom(zoom).unwrap_err().contains("50%–200%"));
        }
        assert!(manager
            .set_zoom(BROWSER_DEFAULT_ZOOM_PERCENT)
            .unwrap_err()
            .contains("浏览器未启动"));
    }
}
