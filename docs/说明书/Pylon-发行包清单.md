# Pylon 发行包清单

本文是 Windows 发行包的施工与验收清单，权威依据是
`scripts/prepare_hermes_runtime.py`、`scripts/pack_release.py` 和
`src-tauri/tauri.conf.json`。它描述当前实现需要什么，不代表未来安装器一定采用
相同的目录名。

## 1. 先看结论

一个可交付的 win64 便携包必须同时包含：

- Pylon 主程序及启动所需的 Tauri/WebView2 loader；
- Agent 检测器；
- 自带的调试 MCP 服务器（`tools/webview2-mcp/`，2026-09-17 起随包分发）；
- 前端资源（字体等）；
- 零 Agent 的 `agents.yaml` 配置模板（#372 起随包：打包时由 `resources/release/agents.template.yaml` 改名收取）和便携模式启动说明；
- `portable.flag` 与空的 `data/` 目录（#482 起便携是唯一存储模式：`data/` 即唯一数据真源）；
- 插件开发分发包 `resources/sdk/`（`dist-plugin-sdk/normal` 全量：单文件 ESM runtime + testing harness + `types/` 类型声明 + manifest schema + package.json，2026-09-01 起随包）；
- 离线文档站 `resources/docs-site/`（#371 起随包：VitePress 离线变体静态产物，应用内 Docs Sheet（`pylon-docs://`）的数据源，与 `docs/说明书/**` markdown 并存）；
- WebView2 兜底安装引导脚本（运行时按 Windows 自带处理，不再内置安装器——2026-09-19 决定）；
- 包外的 SHA-256 文件和 manifest。

默认发行**不携带** Hermes 的 PortableGit 运行时（2026-08-31 决定）：Windows 上 Hermes 解析 Bash 的顺序与 `pylon-core` 的 `hermes::runtime` 一致——① `PYLON_HERMES_RUNTIME_DIR`（开发/CI 覆盖）→ ② 包内 `resources/runtime/git`（仅 `--with-runtime` 包存在）→ ③ `HERMES_GIT_BASH_PATH`（agents.yaml env 或进程环境）→ ④ 本机健康的系统 Git Bash（探测校验，不盲信 `PATH`，避免命中 WSL 的 `bash.exe` 或残缺安装）。需要把完整运行时打进发行包时，对 `pack_release.py` 使用 `--with-runtime`；此时树必须完整。该运行时只给 `provider=hermes` 的 Windows subprocess ACP 子进程使用，不会改写系统 `PATH`，也不会让其他 Agent 自动使用它。

## 2. ZIP 内的目录和文件

打包脚本生成单一顶层目录 `pylon-<version>-win64/`。下表按当前脚本的硬性程度列出
内容：

| 路径 | 要求 | 用途 |
| --- | --- | --- |
| `pylon.exe` | 必须 | Tauri GUI 主程序 |
| `pylon-detect.exe` | 必须 | 本机 ACP Agent 探测器 |
| `WebView2Loader.dll` | 必须 | Windows WebView2 启动依赖；缺失可能导致 `0xC0000135` |
| `pylon-cli.exe` | 建议；存在时自动收集 | CLI 管理工具；当前脚本缺失时只警告 |
| `tools/webview2-mcp/pylon-webview2-mcp.exe` | 必须 | 自带的调试 MCP 服务器（独立进程，走 WebView2 的 `--remote-debugging-port`）|
| `tools/webview2-mcp/README.md` | 必须 | 接线方式，以及「加调试端口等于把窗口对同机任何进程开放」的代价说明 |
| `resources/fonts/*` | 按构建资源实际生成 | 内置字体与呈现资源 |
| `resources/runtime/git/**` | 可选（`--with-runtime`，Hermes） | 完整 PortableGit；至少应能找到 `bin/bash.exe`、`usr/bin/msys-2.0.dll` 及 `true/cat/mktemp/mv/awk/grep.exe`。默认打包会剔除整个 `resources/runtime/` |
| `resources/runtime/portable-git.json` | 可选（`--with-runtime`） | PortableGit 版本、来源和 SHA-256 元数据 |
| `resources/runtime/README.txt` | 可选（`--with-runtime`） | 运行时用途、许可和准备方式说明 |
| `resources/sdk/pylon-plugin-sdk.js` | 必须 | 插件 SDK 单文件 ESM runtime：无 Node/源码环境的相对 import 目标；由 `bun run build:plugin-sdk` 生成 |
| `resources/sdk/pylon-plugin-manifest.schema.json` | 必须 | `pylon-plugin.json` 编辑器校验/补全 schema |
| `resources/sdk/testing.js`、`types/**`、`package.json` | 必须 | 插件开发分发包全量其余部分（2026-09-01 起，打包器从 `dist-plugin-sdk/normal` 收集；缺 `pylon-plugin-sdk.js`/`testing.js`/schema 时打包失败） |
| `resources/docs-site/**` | 必须 | 离线文档站（#371）：`PYLON_DOCS_OFFLINE=1` 构建的 VitePress 静态产物（base 回根、裁 Web 字体，约 2.4 MB），由 `bun run docs:build:offline` 暂存 `src-tauri/resources/docs-site/`、打包器取暂存源入包（#471：跳过 target 的 Tauri 增量拷贝，防历史哈希代际残留）；缺 `index.html` 时打包失败 |
| `README.md` | 必须 | 项目说明（仓库根 README，2026-09-01 起随包） |
| `docs/说明书/**` | 必须 | 全量用户说明书（2026-09-01 起随包） |
| `agents.yaml` | 必须 | 零 Agent 配置模板（#372 起随包：仓库侧 `resources/release/agents.template.yaml` 打包时改名；包内可直接编辑预置 Agent，#326 的裸启动零 Agent 口径不变——模板不含占位 Agent） |
| `README.txt` | 必须 | 解压后首次运行和 Hermes 说明 |
| `portable.flag` | 必须 | 便携标记（#482 起便携是唯一存储模式，`data/` 即数据真源；该文件保留为身份标记，不再参与模式判定） |
| `data/` | 必须为空目录 | 首次运行时保存会话、插件、MCP 等本地数据（#482 起为唯一存储根，不可写时启动致命失败，无 AppData 回退）；WebView2 用户数据（前端 localStorage 的真身）也存在其下 `webview-cache/` 子目录（CC-14 起，删程序文件夹 = 前端数据一起删） |
| `tools/install-webview2.bat` | 必须 | 缺 WebView2 Runtime 时的兜底安装：优先用同目录手动放置的安装器，否则从微软官方 fwlink 联网下载 |

`<version>` 必须同时来自 `package.json`、`src-tauri/tauri.conf.json` 和
`src-tauri/Cargo.toml`，三处不一致时打包应停止。

ZIP 同目录另生成：

- `pylon-<version>-win64.zip.sha256`：ZIP 本身的 SHA-256；
- `pylon-<version>-win64.manifest.json`：每个文件的大小和 SHA-256。

这两个文件是交付校验材料，不需要再放进 ZIP 内。

## 3. 构建前提

在 Windows x64 构建机准备：

1. Bun（1.4+，依赖安装与脚本编排，`bun install`）与 Node.js 22（vite/vitest 等工具仍由 Node 宿主执行）；
2. Rust stable、Tauri 2 所需 Windows 构建工具；
3. Python 3；
4. 能启动目标 Windows WebView2 的环境；
5. 仅当要打 `--with-runtime` 包：首次准备 PortableGit 时可访问 Git for Windows release 下载地址。

PortableGit 二进制树不入 Git 源码仓库。默认发行不需要准备它；`--with-runtime` 打包时，
`prepare_hermes_runtime.py` 会把下载文件缓存在 `.cache/pylon/portable-git/`，把校验通过的完整树暂存到
`src-tauri/resources/runtime/git/`，重复构建会复用校验通过的树。切换上游版本时应
同步更新 `portable-git.json`，不要手工拼接或只复制 `bash.exe`。

## 4. 推荐构建流程

在仓库根目录执行：

```bash
bun install
bun run release:portable
```

`release:portable` 依次完成：

1. 构建前端（`build:wasm` + `tsc -b` + vite build）；
2. 生成正常版与离线版 SDK（打包器从正常版 `dist-plugin-sdk/normal` 全量收取进包；离线版仅作构建期 64 KiB 守卫产物，Tauri 打包的最小集被显式跳过）；
3. 构建离线文档站并暂存（`docs:build:offline`：以 `PYLON_DOCS_OFFLINE=1` 跑 vitepress build，守卫 index.html 存在、无大字体分块、无 Pages 前缀，产物拷入 `src-tauri/resources/docs-site/`——打包器直接取该暂存源入包（#471），须在打包步之前完成）；
4. 构建 Tauri release（不生成安装器；`beforeBuildCommand` 会再执行一次 `bun run build`）；
5. 构建 `pylon-detect.exe`；
6. 构建 `tools/webview2-mcp` 的 release 二进制（`cargo build --manifest-path tools/webview2-mcp/Cargo.toml --release`）；
7. 收集文件、审计、压缩并核对 manifest。打包器会在缺少该 exe 或它的 README、或缺 `resources/docs-site/index.html` 时直接失败——这些能力缺了要到用户真正需要时才暴露，所以按构建期错误处理。默认剔除 `resources/runtime/`（PortableGit）；离线单文件 SDK 的 64 KiB 守卫与 testing/宿主闭包拒绝在 `build:plugin-sdk` 构建期执行，`dist-plugin-sdk/normal` 缺 `pylon-plugin-sdk.js`/`testing.js`/schema 时打包失败。

需要内嵌 PortableGit 的发行，先准备运行时，再对打包脚本加 `--with-runtime`：

```bash
bun run prepare:hermes-runtime
python scripts/pack_release.py --with-runtime
```

「版本号落位 → 本地构建」可用打包脚本的发行编排一键串起（#402）：
`python scripts/pack_release.py --bump X.Y.Z-SUF --build`。`--bump` 把新版本落位到
`package.json`、`src-tauri/tauri.conf.json`、根与成员 crate 的 `Cargo.toml` 及
`Cargo.lock`（先例 `6e7a22d3` 的 9 文件域；成员清单从 `[workspace] members` 动态发现，
独立版本号的 crate 不动），任一文件计数不对即整体中止不写盘，随后按 pathspec 只提交
这些文件；`--build` 跑的就是上面的 `release:portable` 全链，启动前检查构建目标盘余量
（< 10 GiB 拒绝，#228/#399 的 os error 112 教训）。

发行包自 2026-09-19 起不再携带 WebView2 bootstrapper（`--without-webview2` 选项随之移除，
见 ADR-0014）：Runtime 按 Windows 自带处理；包内 `tools/install-webview2.bat` 在系统缺
WebView2 时联网下载安装器，发布说明无需再区分常规/降级包。

## 4.1 谁来发布（2026-09-22 起，#232：打 tag 即发行）

发行由 CI 完成：合并 PR 进 main 后，打 `v<version>` tag 并推送，`.github/workflows/release.yml`
自动执行版本一致性守卫（tag = `package.json` = `tauri.conf.json`）与 main 归属守卫（tag 必须
位于 main 之上），随后运行 `bun run release:portable`，把 zip / `.sha256` / `.manifest.json`
三件资产上传到该 tag 的 Release。本地 `bun run release:portable` 保留为出包与排障手段，不再
承担发布步骤。

`workflow_dispatch` 保留为预演/重试入口：在分支上 dispatch 只构建、不发布。

打 tag 这一步可由 `python scripts/pack_release.py --upload` 代劳（#402）：脚本先校验
工作树版本一致、tag 尚不存在、HEAD 是远端 main 的祖先（即版本提交已经 PR 合并），通过后
打 `v<version>` 并推送触发发行。agent 侧的完整操作路径（含先问版本号与是否上传的约定）
见 `.agents/skills/release/SKILL.md`。

## 5. 打包前后验收

### 构建前

- [ ] 三处版本号一致，目标架构为 win64。
- [ ] 仅 `--with-runtime` 包：`python scripts/prepare_hermes_runtime.py` 成功，且运行时校验通过。
- [ ] 仅 `--with-runtime` 包：`resources/runtime/git/bin/bash.exe`、`usr/bin/msys-2.0.dll` 和关键命令均存在，
      `portable-git.json` 的 URL、版本和 SHA-256 与本次树一致。
- [ ] `resources/sdk/` 开发分发包齐全：`pylon-plugin-sdk.js`、`testing.js`、manifest schema、`types/`、`package.json`。
- [ ] 离线 SDK bundle 不超过 64 KiB；正常版 package（含 `./testing` 类型入口）在插件开发套件中可独立导入。
- [ ] 离线文档站已构建并暂存：`src-tauri/resources/docs-site/index.html` 存在（`docs:build:offline` 的三项守卫通过）。
- [ ] 真实 `agents.yaml`（任何非包根位置）、`.env`、密钥和本机绝对路径没有被放入待打包目录；包根 `agents.yaml` 只能来自 release 模板改名（#372）。

### 打包后

- [ ] `python scripts/pack_release.py --verify-only <zip>` 通过。
- [ ] 使用 `Get-FileHash <zip> -Algorithm SHA256`（或等价工具）核对 `.sha256`。
- [ ] ZIP 只有一个 `pylon-<version>-win64/` 顶层目录，并包含空 `data/`。
- [ ] 包内 `tools/webview2-mcp/` 同时有 `pylon-webview2-mcp.exe` 与 `README.md`；该 exe 能独立运行（`--version` / `--help` 先于一切校验）。
- [ ] 包内 `resources/docs-site/index.html` 存在；应用内打开 Docs Sheet 能看到文档站首页，站内导航与本地搜索可用，`docs/说明书/**` markdown 仍在包内（#371）。
- [ ] 解压到全新目录后可启动 `pylon.exe`；没有 WebView2 时，运行 `tools/install-webview2.bat` 能完成联网安装。
- [ ] `pylon.exe` 是 GUI 子系统（PE `OptionalHeader.Subsystem` = 2，与 `notepad.exe` 同类），
      双击启动**不出现控制台窗口**（#361）。顺带确认起始阶段与 agent 会话不会闪黑框：
      改了子系统后，任何漏加 `CREATE_NO_WINDOW` 的 spawn 都会浮出来（收口见 `pylon_foundations::child_command`）。
- [ ] 使用 `provider=hermes` 的 Agent 发起一次真实 ACP 会话：默认包确认 Hermes 能解析
      本机标准路径的健康 Git Bash 并完成最小工具调用；`--with-runtime` 包确认 Hermes 使用包内 Bash。
- [ ] 使用一个非 Hermes Agent 启动会话，确认它不继承 Hermes 的 Bash 路径和变量。
- [ ] 检查 `manifest.json` 中的文件数量、大小和 hash 与 ZIP 内容一致。
- [ ] 仅 `--with-runtime` 包：保留 PortableGit 自带的 `LICENSE.txt`、`README.portable` 及其余上游许可/声明，
      不要为了缩小体积删除运行时文件。

## 6. 明确不能放进发行包的内容

打包脚本会拒绝或应人工清除以下内容：

- 真实 `agents.yaml`、`.env`、API key、token、密码和真实本机路径（#372 起唯一例外：包根 `agents.yaml`——由打包器从 `resources/release/agents.template.yaml` 改名收取的零 Agent 模板；其他位置的 `agents.yaml` 一律拒绝）；
- 源码目录 `src/`、`src-tauri/src/`、`.git/`、`node_modules/`；
- `*.pdb`、`*.rlib`、`*.d`、开发期 target 中间文件；
- `--with-runtime` 包中未经校验的残缺 PortableGit 目录（默认包则根本不携带该树）。

默认发行不携带运行时：Hermes 依赖探测校验过的本机系统 Git Bash；探测会拒绝 WSL
的 `bash.exe` 与残缺安装，不接受任意 `PATH` 命中，因此不要用"把某个 bash 塞进
包里凑数"的方式绕过。

PortableGit 上游文本中的示例路径和许可内容属于第三方运行时，脚本对该树采用结构
校验而非把上游文档当作 Pylon 配置扫描；不要因此修改或删减上游文件。

## 7. 安装包（NSIS/MSI）补充

安装包不是 ZIP 的替代审计对象。`tauri.conf.json` 仍声明 `resources/runtime`，但默认
安装包与默认 ZIP 一致，不包含 PortableGit；只有按 `--with-runtime` 语义构建的安装包
才必须检查安装后的资源目录仍包含完整 PortableGit：

```bash
bun run tauri -- build --bundles nsis,msi
```

安装后应从实际安装目录验证：默认包确认 Hermes 解析本机系统 Git Bash，
`--with-runtime` 包确认 `resources/runtime/git` 完整，并分别测试 Hermes 与非 Hermes
Agent。安装器的 WebView2 下载策略由 Tauri 配置决定；若企业环境禁止联网，仍应提供
可离线获得 WebView2 的交付方案。

## 8. 运行时升级记录

本节仅影响 `--with-runtime` 发行；默认发行不携带 PortableGit，无需此节。

升级 PortableGit 时按以下顺序操作：

1. 更新 `src-tauri/resources/runtime/portable-git.json` 的版本、asset、URL 和 hash；
2. 运行 `python scripts/prepare_hermes_runtime.py --force`；
3. 重新构建并执行本清单的 Hermes/非 Hermes 验收；
4. 保留上游许可证和来源记录，并在发布说明中记录新版本与 ZIP hash。

不要把下载缓存或 `src-tauri/resources/runtime/git/` 强行加入源码提交；它们属于构建
输入和发布产物，不属于项目源文件。
