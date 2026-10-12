# Dev Record — #266 CC-14 首启落终端默认 + WebView2 数据跟包

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-266-cc14-first-run-terminal-webview-udf.md`

## 元信息

- issue：[#266](https://github.com/Teens-in-Times/Pylon-co-works/issues/266)（⑧ → CC-14）
- 分支：`feat/cc-14-first-run-terminal.1`（基于 `origin/main @ b745e5b0`）
- 提交范围：`b745e5b0..<head>`（开工声明 `8e5cace7` + 实现提交）
- 日期：2026-10-06

## 目标与范围

1. **首启种子**：持久化没有 `pylon-theme` 存档 ⇒ 界面模式落 `terminal-like` 并套用「终端默认预设」值；第二次启动 no-op。
2. **数据跟包**：WebView2 用户数据目录从 `%LOCALAPPDATA%\com.prism.desktop` 改指 `<exe_dir>/data/webview-cache`（删程序文件夹 = 前端数据一起没）；主窗口 + browser 子 WebView + docs 子 WebView 全部生效。

**不做**：不 bump `THEME_SCHEMA_VERSION`、不写数据迁移、不改 `DEFAULT_INTERFACE_MODE`、不碰 `%APPDATA%`/`%LOCALAPPDATA%` 旧遗留、不动预设内容与出厂数据、不做换包检测。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/paths.rs` | 新增 `webview_user_data_dir(&DataDirs)`（= `data_root/webview-cache`，纯路径不触盘）+ 测试模块 1 条单测 | 修改 |
| `src-tauri/tauri.conf.json` | `app.windows` 清空（主窗口改代码创建） | 修改 |
| `src-tauri/src/lib.rs` | 新增常量 `MAIN_WINDOW_ADDITIONAL_BROWSER_ARGS`（原 config `additionalBrowserArgs` 唯一权威）；`run_setup_pipeline` 阶段 1/2 对调（DataDirs 先于建窗）；`setup_open_main_window` 重写为 `WebviewWindowBuilder::from_config` + `.data_directory(...)` 代码建窗（字段逐项照抄原 config，label 保持 `main`，`set_title("Pylon")` 保留） | 修改 |
| `src-tauri/src/browser/mod.rs` | `host_additional_browser_args` 改读常量（原从 `config().app.windows` 读，config 清空后失效——连带修正）；`open_tab_in` 取 DataDirs + builder 挂 `.data_directory`；imports 加 `Manager` | 修改 |
| `src-tauri/src/docs_sheet/mod.rs` | `open` 同款：取 DataDirs + builder 挂 `.data_directory` + 调用点签名同步 | 修改 |
| `src/app/bootstrap/firstRunThemeSeed.ts` | 新增 `applyFirstRunThemeSeed()`：判定（`resolveLocalStorage` 取不到 `pylon-theme`）+ 动作（先 `setInterfaceMode('terminal-like')` 再 `resetTheme()`，顺序写死） | 新增 |
| `src/main.solid.tsx` | 接线：`startupMark('main_module_eval')` 后、`render(<KernelRoot/>)` 前同步调用种子 | 修改 |
| `src/app/bootstrap/appBootstrapTransaction.solid.ts` | 曾按单子建议挂 `hydrateDomains` 尾部，实机验证被挂载期写盘抢先（见「与 spec 的偏差」），已回退，最终无改动 | （过程性） |
| `src/app/bootstrap/__tests__/firstRunThemeSeed.test.ts` | 新增 3 条测试 | 新增 |
| `docs/说明书/Pylon-发行包清单.md` | `data/` 行补 `webview-cache/` 表述 | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | paths.rs 行补 `webview_user_data_dir` 与主窗代码创建说明 | 修改 |

`docs/说明书/Pylon-插件系统说明书-用户版.md` grep 核对：插件数据仍随便携根，表述无过时，未改。

## 方案要点

- **种子判定与动作**：`applyFirstRunThemeSeed(storage = resolveLocalStorage())`——`storage?.getItem('pylon-theme') != null` 即 no-op 返回 false；否则先 `useInterfaceModeStore.setInterfaceMode('terminal-like')` 再 `useThemeStore.resetTheme()`（resetTheme 落点 = 当前模式默认预设，顺序颠倒会落 GUI 预设）。呈现方案不归种子管，`ensureInterfaceModeProfile()` 在模式就绪后自动激活 terminal-classic。
- **接线选点（关键）**：`main.solid.tsx` 模块求值尾、`render` 之前。主题域 persist 随模块求值**同步** rehydrate（`attachSolidPersist` 同步 hydrate 路径），该点满足「rehydrate 完成之后」硬约束；而单子列举的 `bootstrapApplication` hydrate 之后 / `applicationBootstrapRun` 两个选点**实测不可用**——App 挂载期 effect（`ensureInterfaceModeProfile` 的 rememberProfile / 写路径）在 bootstrap `await` 间隙就经 persist writeBack 落盘 `pylon-theme`，种子判定被抢先误判「已有存档」（首轮实机：mode 停留 modern-gui、accent 停留裸默认 `#3b82f6`）。
- **UDF 跟包**：config 的相对 `dataDirectory` 会被 tauri 解析到 `app_local_data_dir/<label>/`，表达不了包内路径 ⇒ 只能代码建窗。`WindowConfig` 字段逐项照抄原 `tauri.conf.json`（title `Prism Desktop` / 1200×800 / min 800×600 / decorations=false / transparent=true / center=true / additionalBrowserArgs 原样），`..Default::default()` 兜底其余字段（默认值与 serde 缺省一致）。data_dirs 解析挪到建窗之前（阶段 1/2 对调）。
- **`host_additional_browser_args` 连带修正**：该函数原从 `config().app.windows` 按 label 取参数串，config 清空后恒 None ⇒ 子 WebView 退回 wry 默认参数，与主窗环境不一致 ⇒ WebView2 第二环境创建直接失败（browser/mod.rs 注释记载的「空壳窗口」坑）。改读 `crate::MAIN_WINDOW_ADDITIONAL_BROWSER_ARGS` 常量（签名去掉用不上的 window 参数，两个调用点同步）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁七步（lint / build:example-plugin / build / check:solid / test / check:rust / check:clippy） | 全绿：lint EXIT=0；build ✓ built in 25.01s；check:solid EXIT=0（含 176 字段一致性、锚点 23 全等）；test **681 文件 / 5311 用例**（基线 680/5308，净增 1 文件 3 用例）；check:rust EXIT=0（含 workspace lib test 982 全绿 + fmt --check）；check:clippy EXIT=0（修复 1 条新增 `field_reassign_with_default` 后零新增诊断） |
| 实机 a：清空 `data/webview-cache` → 启动落终端默认 | ✓ `dataset.interfaceMode='terminal-like'`、`pylon-interface-mode` 持久化 `terminal-like`、信封 accent `#6366f1`、globalFontSize 17、msgStyle `terminal`、messageLayout `classic`（glass 值而非裸默认 `#3b82f6`/18/bubble）；appliedPreset 全 `''` + custom 全 false ⇒ 预设行无悬空 chip；设置面板「✓经典终端」选中、强调色输入框 `#6366f1` |
| 实机 b：改外观值 → 重启保留；`webview-cache/EBWebView` 出现 | ✓ UI 事件改强调色 → `#e11d48` 落盘（custom.global=true）→ 重启后保留；`data/webview-cache/EBWebView/` 存在 |
| 实机 c：删 `webview-cache` → 重启重新落终端默认 | ✓ accent 回 `#6366f1`、globalFontSize 17、msgStyle terminal、terminal-like、custom.global 回 false（缓存语义复现） |
| 实机 d：`%LOCALAPPDATA%\com.prism.desktop` mtime 不再变化 | ✓ 三次启动前后 mtime 均为 `2026-09-30 18:39:40`（与启动前基线逐字相同），EBWebView mtime 亦停在 `2026-10-05 20:30:31`（旧位置零写入） |
| 实机 e：host 浏览器窗 / docs 窗正常（共享新 UDF） | ✓ Browser 子 WebView 成为独立 page 目标（CDP 可达、JS 可执行）；docs 窗 page 目标 `pylon-docs.localhost/index.html` 正常加载；后端日志 0 error、无环境创建报错；docs console 仅 favicon 404（既有瑕疵，与本单无关） |
| 新增单测 | ✓ `firstRunThemeSeed.test.ts` 3 条 + `paths.rs` 1 条全绿 |
| 反向验证 | ✓ 两组新测试均改坏→红→改回→绿（红样见「证据」） |

## 测试处置

- **新增**：`src/app/bootstrap/__tests__/firstRunThemeSeed.test.ts`（3 条：空存储→true+terminal-like；空存储→主题值对拍 `DEFAULT_PRESETS.terminal.theme` 预设域字段 + `pylon-theme` 信封落盘 version=11 + accent `#6366f1`；已有 `pylon-theme`→false+两 store 引用级零变化）。注意 `beforeEach` 顺序：先 `setState(getInitialState(), true)` 恢复内存态、后 `localStorage.clear()`——顺序颠倒会被恢复动作自身的 writeBack 写脏「空存储」前提。对拍范围用 `filterPresetTheme` 过滤：`resetTheme` 只把预设域字段换成预设值，`sidebarWidth`/`rightWidth` 等非预设域字段来自 `DEFAULTS`（首轮对拍因含 `rightWidth` 250≠260 红过一次，属测试写法修正）。
- **新增**：`paths.rs` `webview_user_data_dir_is_data_root_webview_cache`（1 条）。
- **既有测试零改动**（`themeSchemaV8Backfill` / `defaultPresets.solid` / `interfaceMode` 均未触碰）。

## 证据

- commit：`8e5cace7`（L.md 开工声明）；实现提交见分支 `feat/cc-14-first-run-terminal.1`。
- 反向验证红（种子判定反转 `!=` → `==`，原样）：
  - `applyFirstRunThemeSeed > 空存储 ⇒ 首启：返回 true，界面模式落 terminal-like` — `AssertionError: expected false to be true // Object.is equality` — `src/app/bootstrap/__tests__/firstRunThemeSeed.test.ts:33:38`
  - `applyFirstRunThemeSeed > 已有 pylon-theme ⇒ no-op：返回 false，两 store 状态零变化` — `AssertionError: expected true to be false // Object.is equality` — `src/app/bootstrap/__tests__/firstRunThemeSeed.test.ts:63:38`
  - （空存储对拍条同轮红：`:38:38`）
- 反向验证红（`webview_user_data_dir` 改返 `config_root`）：`thread 'paths::tests::webview_user_data_dir_is_data_root_webview_cache' panicked at src\paths.rs:248:9: assertion left == right failed, left: "C:/pylon-config\\webview-cache", right: "D:/pylon-data/webview-cache"`；改回后 `ok. 1 passed`。
- 实机复现命令：`cargo build --manifest-path src-tauri/Cargo.toml && rm -rf src-tauri/target/debug/data/webview-cache && cd src-tauri/target/debug && ./pylon.exe`（调试端口经 `MAIN_WINDOW_ADDITIONAL_BROWSER_ARGS` 内置 9222）；读数经 `tools/webview2-mcp`（webview_targets / webview_evaluate / tauri_backend_logs）。
- 门禁计数行：`Test Files 681 passed | 1 skipped (682)` / `Tests 5311 passed | 1 skipped (5312)`；`cargo test --workspace --lib`：`982 passed; 0 failed; 4 ignored`。

## 与 spec 的偏差

1. **种子接线点**：单子 §4-6 建议「bootstrapApplication 的 hydrate 之后 / applicationBootstrapRun.ts」，并授权「以实际管道结构为准，回单注明」。实测两个列举选点都被 App 挂载期写入抢先（详见「方案要点」），最终落在 `main.solid.tsx` render 之前——硬约束（主题域 rehydrate 之后、二次启动 no-op）全部满足。
2. **`host_additional_browser_args` 连带修正**：单子未点名该函数，但「清空 `app.windows`」必然使它失效（子 WebView 环境参数取不到 ⇒ 第二环境创建失败 ⇒ 验收 e 必挂），属单子改动 2 的直接连带，不是顺手优化。browser/mod.rs 在单子改动文件列表内。
3. **`docs_sheet`/`browser` 需要自行取 DataDirs**：子 WebView builder 挂 UDF 需要 DataDirs 入参，两处经 `window.app_handle().state::<AppState>().data_dirs_cloned()` 获取（并在各自 phase 置 Starting 之前取，失败提前返回不留悬挂态）。

## 未解问题

- 手动 `cargo test --lib` 曾出现一次偶发失败（981 passed / 1 failed，失败用例名未捕获），随后两次连跑全绿（982/0）；`check:rust` 链内的同命令全程绿。疑似时序型 flake（输出上下文为 session 流式截断类测试），与本单改动文件无交集。留观，若 CI 复现按流程另立。

## 并行交集

- `.agents/L.md`（开工声明，单独提交 `8e5cace7`，完工后可撤条目）
- `src-tauri/src/lib.rs`、`src-tauri/tauri.conf.json`（setup 管道与窗口配置——若他人在改启动时序请对齐）
- `src/main.solid.tsx`（入口接线点）
