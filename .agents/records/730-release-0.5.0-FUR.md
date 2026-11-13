# Dev Record — #730 0.5.0-FUR 发行与生产升级

- 署名：Codex
- 日期：2026-11-13
- 分支：feat/chat-modern-ui；基准 15e93a45（已合并 #729）
- 用户授权：构建 release、打包上传 GitHub、替换本机生产实例；明确选择版本 0.5.0-FUR。

## 版本与构建

使用 release skill 及 scripts/pack_release.py --bump 0.5.0-FUR --build，版本落位提交 8a4eb29a。未手改版本文件，未更改本轮已验收的前端行为。G 盘余量接近门槛，本轮 CARGO_TARGET_DIR 为 D:/DevCache/pylon-release-target。

## 验证

- #729 合并前 GitHub 8 项检查均 SUCCESS；其最终本地证据见 728-frontend-production.md。
- 本轮 bun run test:pack：45 项通过，退出 0，target/730-pack-tests.log。
- 本轮 bun run check:clippy：退出 0，基线外新增诊断 0；17 文件 / 55 处 await 清单一致、裸 allow 0，target/730-clippy.log。
- release 全链退出 0（target/730-release-build.log），本地 ZIP 39,191,005 bytes；296 项 manifest 与 ZIP 一致、内容审计通过。SDK、离线文档、检测工具和 MCP 工具均由正式全链生成。正式资产和生产部署最终证据回写 [#730](https://github.com/Teens-in-Times/Pylon-co-works/issues/730)，版本 PR 不自动关闭该 issue。

## 生产定位与回滚

生产路径 F:/A-I/Platform/Pylon，入口 pylon.exe；原程序 ProductVersion=0.4.4-KXP，大小及 SHA256 与正式发行 manifest 一致。主程序检查时未运行；两个 MCP helper 使用安装目录内工具，替换时需兼容在用文件。

完整备份位于 D:/Project/Pylon-backups/before-0.5.0-FUR-20261113/Pylon。复制后逐文件 SHA256 核对：1003 文件、0 不匹配。保留整个 data 及 agents.yaml、agents.yaml.bak；备份未进入发布包或版本库。部署仅替换发行清单拥有的文件，配置、会话数据库及 WAL/SHM、插件和凭据保留。出现升级失败时从完整备份恢复。

## 测试处置与边界

初始版本落位没有增加、删除或放宽测试；后续打包器修复新增 7 项承重回归，见下文。公开发行已通过 main 归属守卫；tag CI 打包失败后的实际发行来源在下文明确记录。无其他在途代码改动，.peri/ 保持原状。开发规格目标已在此承接。

## 发行 CI 工具链差异修复

PR #731 首轮 CI 使用 Rust 1.100.0，本机为 1.99.0；前端静态、两组 Vitest 与 ACP shadow 通过，但新版 Clippy 报 4 处基线外诊断。直接移除 `gateway/instance.rs`、`agent_detection/evidence.rs`、`foundations/workspace.rs` 中生命周期已结束值的冗余 clone；`acp/process.rs` 将 Unix errno 快路保留在前，返回通用 ErrorKind 判定，保持各平台 busy 判断语义。未增加 allow、改基线或改变测试契约。两处 ownership 修复由子 agent 独立核对并实施，主线统一运行 fmt、workspace lib tests、Clippy 和 release 预演，最终结果续写 #730。

本地第一轮 release 在隔离目录实机启动：1200×800、3 个布局表面检查通过、Tauri invoke 为 function；离线文档子窗口 ready=complete、10 个链接、无水平溢出；主窗口控制台 warning/error/exception 0。调试实例已经正常退出。最终发布资产另做了下载、安装与启动验收，见下文。

修复后本地 `bun run check:clippy`、`bun run check:rust` 与 release 全链均退出 0；Rust 1,747 passed / 4 ignored（含 11 项 fake-agent），ACP parity 通过，296 项打包清单匹配。首次直接调用 workspace lib 测试时新目标目录缺 fake-agent，保留失败日志后改走完整 check:rust 前置链；未修改测试。PR #731 最终 head d75ee328 的 8 项 CI 全绿并合并为 4864febe，v0.5.0-FUR 指向该提交。

## 覆盖率开发依赖修复

合并后 main 专属覆盖率作业 run 43367975153 暴露旧有依赖错配：PR #714 的 7ebbf3e6 仅将 coverage provider 升到 5.0.5，Vitest runner 仍为 4.1.11。采集器抛出 702 次 `coverageFilesDirectory is required`，该次 coverage 执行不完整、0% 结果无效；不能将它当作测试通过。

将 `vitest` 与 `@vitest/coverage-v8` 精确对齐 4.1.11，锁文件只调整对应开发依赖；未改运行时代码、统计范围、阈值或发行 tag。`bun run test:coverage` 退出 0（target/730-coverage-fixed.log）：statements 82.74%（47496/57401），branches 74.58%（29157/39090），functions 83.39%（14577/17480），lines 86.99%（35107/40353），均高于既有 79/72/79/83 门槛。原施工文件域已完成并移除 L.md 条目；正式资产及本机生产启动证据继续回写 #730。

## Cargo 1.100 打包兼容与实际发行来源

Release run 43368239953 的应用、检测器与 MCP 均编译成功，最后打包因旧 OUT_DIR glob 未找到 WebView2Loader.dll 失败。[Cargo 官方文档](https://doc.rust-lang.org/nightly/cargo/reference/build-cache.html) 明确 1.100 改变内部 build-dir 布局。改为冻结、离线 `cargo metadata` 定位锁定的 webview2-com-sys 源包，收取其 x64 DLL，不依赖内部布局、不复用 release/debug 残留、不隐式构建；同步说明书，纠正当前 MSVC 静态链接下 DLL 为启动必需的过时表述。既有随包 DLL 契约保持。

7 项回归覆盖锁定来源、旧副本不可遮盖、架构、缺失/多版本依赖、命令失败及无效元数据，`bun run test:pack` 52 项通过。真实 metadata 调用成功且 Cargo.lock 哈希不变。锁定源包、当轮 OUT_DIR、本地 ZIP 与 manifest 的 DLL SHA256 四方一致：`8427b1fc58ec707813e5c0a51eb5d69397bb333250a7b891be4d3b123f1e0f1c`。新打包器不改本版已发布资产，CI 预演结果续写 #730。

未移动或重写 v0.5.0-FUR。实际上传的是 tag 同树代码（d75ee328 与 merge 4864febe 树一致）经完整本地 release 全链构建的 Windows / Rust 1.99.0 产物；Release 页面明确注明此来源和远端打包故障。三件资产已上传并重新从 GitHub 下载：ZIP 39,191,031 bytes，SHA256 `a1d28d75e195a262b540efc82baef8be726fb857d5e4df1bed2105fc8d4d678`；296 个文件集合与 manifest 完全一致，逐项大小/哈希及内容审计通过。

## 生产安装与验收

2026-11-13 05:11 UTC 安装至 F:/A-I/Platform/Pylon：再次核对原目录 1003 文件与完整备份一致，覆盖 40、相同跳过 255，共 295 个发行文件哈希全部匹配；agents.yaml 按用户配置例外保留。整个 data 与两份 Agent 配置共 527 文件在复制前后哈希不变。两个在用 MCP helper 的旧映像改名保留，未断开连接；原路径已放入与发行 manifest 一致的新 helper，既有进程待客户端重启后加载新映像。

安装后 ProductVersion=0.5.0-FUR；主程序 SHA256 `10c2ecece4e4e35761b598dbe9f440394faa8fa23d5a14b9993792653cd6ff94`。真实生产 WebView2 验收：1200×800，4 个布局表面通过；terminal-like 模式保留，Tauri invoke 可用、输入可编辑、无可见错误边界；设置菜单 4 组文字列宽均 175.99px，开关菜单无新增控制台错误。证据仅保存在 target/qa-730，未上传用户会话截图。

验收边界：启动时旧皮肤 schema 按现行结构清洗产生 1 条警告；历史 Provider 错误已在只读备份中确认发生于 2026-10-29，含 HTTP401。另有本次远端 session/load 的 2 次 rpc_error（间隔约 2 秒），0 事件进入、投影未开始，不能声称会话恢复成功。未修改 Agent 凭据或发送测试 prompt。调试实例已正常关闭；生产以普通模式重新启动 PID 228164，进程响应正常、9222 监听数为 0。

备份复核边界：SQLite 的 mode=ro/query_only WAL reader 仍更新了备份 `-shm` 的临时读锁信息；主库与 WAL 的修改时间未变，连接已关闭。1003 文件逐项一致证据属于部署前快照，不能表述为读取后的备份 SHM 仍逐字一致；该 SHM 为可重建的共享索引/锁元数据。后续审查应先复制完整数据库及 sidecar 到临时目录再打开。

## 干净 CI 缓存的发行准备

#732 已合并为 0d28a7a6，PR 与 main 的 8 项 CI 均成功，main 覆盖率采集已恢复正常。完整发行预演 43371090189 则发现离线 metadata 缺 `caseless 0.2.2`：它来自 workspace 的 pylon-markdown → comrak 链；GUI 构建和 WASM 缓存命中不能保证所有工作区源包已下载。该失败属于依赖准备缺失，未改动已发布资产或正在运行的生产程序。

新增 `prepare:release` 作为 `release:portable` 的第一步：`cargo fetch --locked --target x86_64-pc-windows-msvc` 明确准备锁定工作区依赖，再真实调用离线 loader resolver，依赖或来源问题在耗时编译前失败。最终 pack 阶段不联网、不构建、不修改锁文件。没有添加只断言脚本文字的测试；沿用 52 项打包回归，并执行真实准备命令与干净 CI 前置验证。最终结果续写 #730。
