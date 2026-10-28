# Dev Record — #330 发行构建内置 CDP 调试端口（9222）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-330-release-cdp-off.md`

## 元信息

- issue：[#330 bug(security): 发行构建内置 CDP 调试端口（9222）——同机任意进程可向窗口注入 JS](https://github.com/Teens-in-Times/Pylon-co-works/issues/330)
- 分支：`fix/release-cdp-off`（基于 `github/main` = `e1eced0c`）
- 提交范围：`7d85fe61`（L.md 单行登记）→ 本提交（Rust 常量 + 一条守卫单测 + skill/说明书/README 同步 + 本 record）
- 日期：2026-10-28
- 施工署名：Qoder（L.md 已登记）
- 关联：#85（webview2 MCP 接入，spec 未决问题 1 已写明「开放调试端口不应进入对外分发的构建」）；`4ddff6a0`（0.2.1 仓库主决定把端口内置进发行包，本条即该决定的收口）

## 目标与范围

**做**：产品二进制不再自带 CDP 端口；调试端口改为启动时按需注入；加回归守卫防止端口被重新塞回常量；同步所有「构建默认带端口」的文档口径。

**不做**：`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection` 组合（#330 无涉，原样保留）；`tools/webview2-mcp/` 的程序与随包分发决策（2026-09-17 仓库主决定）；`scripts/perf-bench/README.md` 的采样流程（它本来就走环境变量）；不引入编译期分档。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/lib.rs` | `MAIN_WINDOW_ADDITIONAL_BROWSER_ARGS` 常量去掉 CDP 两参数；常量注释写明替代通道；文件尾新增守卫单测模块 | 修改 |
| `src-tauri/src/browser/mod.rs` | `host_additional_browser_args` 与 `open_tab_in` 的过时注释（「本仓内即调试端口那一串」等） | 修改 |
| `src-tauri/src/docs_sheet/mod.rs` | 同上，删掉「本应用窗口固定带调试端口那一串」 | 修改 |
| `.agents/skills/webview2-acceptance/SKILL.md` | 前置第 1 条：端口不再内置，改为必须用环境变量开启（debug/release 一致） | 修改 |
| `tools/webview2-mcp/README.md` | §二.1 与附录 A：环境变量是唯一开启通道；复核命令里 `remote-debugging` 只可能来自环境变量 | 修改 |
| `docs/说明书/Pylon-发行包清单.md` | §1 结论：发行二进制不内置调试端口 | 修改 |
| `.agents/records/issue-330-release-cdp-off.md` | 本记录 | 新增 |

## 方案要点

1. **采用 issue 期望行为（候选 a），不采用 `cfg(debug_assertions)` 分档（候选 b）。**
   - issue 原文期望：「发行构建不带调试端口；调试能力按需以环境变量（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`）注入」。
   - 实测支撑：`tools/webview2-mcp/README.md` 附录 A 在 WebView2 运行时 153.0.4234.32 上测过，环境变量是**追加**在应用参数之后，不是覆盖。⇒ 常量里删掉端口后，环境变量通道照常生效，且不需要把 `--disable-features` 抄进环境变量。
   - (b) 会让 debug 构建长期内置端口、两档行为两套文档，收益只是在「忘了设变量」时兜底；本仓所有调试入口（skill / perf-bench / MCP README）本来就是带变量启动的，兜底价值不成立。
2. **字节一致性不变量不变**：主窗口（`lib.rs`）、Browser 子 WebView（`browser/mod.rs`）、Docs Sheet 子 WebView（`docs_sheet/mod.rs`）仍共用 `host_additional_browser_args()` 返回的同一串——同一 user data folder 下 WebView2 要求各环境参数逐字节一致。变的是「共用什么」，不是「共用」这件事。
3. **守卫单测**（`window_browser_args_tests::built_in_browser_args_carry_no_cdp_port`）：断言常量不含 `remote-debugging` / `remote-allow-origins`，且仍含 `--disable-features=…`。纯字符串断言，不启动 WebView2，CI 无副作用。
4. **注释收敛**（AGENTS §6.2）**：顺手删掉 CC-14 遗留的重复段落与「tauri.conf 的 additionalBrowserArgs」等已过期表述。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `src-tauri/src` 内无内置 CDP 参数 | ✅ `grep -rn "remote-debugging" src-tauri/src` 仅剩 3 处说明性注释（指明「已移除、改用环境变量」），无参数串 |
| 守卫单测通过 | ✅ `cargo test -p pylon --lib window_browser_args` → `1 passed; 0 failed`（986 filtered out），EXIT=0 |
| 反向验证：端口塞回常量时守卫变红 | ✅ 临时改回旧常量 → `FAILED. 0 passed; 1 failed`，EXIT=101，panic 信息打印整串参数 |
| 不设环境变量启动：9222 无监听 | ✅ `curl -m 3 http://127.0.0.1:9222/json/version` exit=7（连接被拒）；`netstat` 无监听；`msedgewebview2.exe` 命令行只有 `--disable-features=…` |
| 设环境变量启动：端点可连 | ✅ 返回 `{"Browser":"Edg/156.0.4314.50", …, "webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/…"}`，curl exit=0；命令行出现 `--remote-allow-origins=* --remote-debugging-port=9222`（追加在应用参数之后） |
| rustfmt | ✅ `cargo fmt --all --check` EXIT=0 |
| clippy 门禁 | ✅ `bun run check:clippy`（见「证据」） |

## 测试处置

- 新增：`src-tauri/src/lib.rs` → `window_browser_args_tests::built_in_browser_args_carry_no_cdp_port`。
- 修改/删除既有测试：无（仓内没有断言该常量内容的用例；`host_additional_browser_args` 的 `Some(…)` 契约未变）。

## 证据

- commit：`7d85fe61`（L.md 登记）→ 本提交
- 单测：`cargo test -p pylon --lib window_browser_args` → `test result: ok. 1 passed; 0 failed … 986 filtered out`，EXIT=0
- 反向：同命令在端口回填后 → `test result: FAILED. 0 passed; 1 failed`，EXIT=101
- 构建：`cargo build -p pylon` → `Finished dev profile … in 58.37s`，EXIT=0
- 真机（无环境变量）：`curl -s -m 3 http://127.0.0.1:9222/json/version` → 空输出，`curl_exit=7`；`netstat -ano | grep :9222` 无监听；WebView2 命令行 `--user-data-dir="…/target/debug/data/webview-cache/EBWebView" --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`（无 `remote-debugging`）
- 真机（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222 --remote-allow-origins=*"`）：返回 `/json/version` 的 `Browser: Edg/156.0.4314.50`，`curl_exit=0`；命令行 `remote-allow-origins=*` / `remote-debugging-port=9222` 出现在应用参数之后
- 收尾：`taskkill /IM pylon.exe /F`，之后 `netstat` 仅剩本机 curl 的 `TIME_WAIT` 客户端套接字（无监听）

## 与 spec 的偏差

无。spec 里候选 (a)/(b) 的取舍结论与实施一致；文档同步范围比 spec 多列了 `docs_sheet/mod.rs` 与 `browser/mod.rs` 的注释收敛（同属「过时表述」，AGENTS §6.2 要求顺手清）。

## 未解问题

1. **发行包内的 MCP 从此需要显式变量**：`tools/webview2-mcp/` 仍随包分发（2026-09-17 决定不变），但拿到 zip 的人要先按 README 带 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 启动才能连上。这是 #330 期望行为的有意代价；「开箱即用」若日后又要，属新决策。
2. **未做 Browser/Docs 子 WebView 的真机回归**：两条子 WebView 创建路径未改动（仍调用同一函数），字节一致性属代码不变量；本轮只在主窗口上验证了端口两态。要做实机确认需打开 Browser Sheet 后比对 `msedgewebview2.exe` 命令行——留给下次动 browser 域时顺手做。
3. **历史记录不动**：`.agents/records/` 里多条旧记录写着「tauri.conf 内置 9222」，属当时的真实状态，按「不改写历史」保留。

## 并行交集

碰过 `src-tauri/src/{lib,browser/mod,docs_sheet/mod}.rs`、`.agents/skills/webview2-acceptance/SKILL.md`、`tools/webview2-mcp/README.md`、`docs/说明书/Pylon-发行包清单.md`、`.agents/L.md`。与 #602（`runtime.rs` / `test_utils.rs` / `ci.yml`）、#593/#600/#607（TS 面）、#613/#619（用例面）文件域不重叠。
