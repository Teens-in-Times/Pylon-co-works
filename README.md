# Pylon

[![CI](https://github.com/AlchemistCxC/Pylon-co-works/actions/workflows/ci.yml/badge.svg)](https://github.com/AlchemistCxC/Pylon-co-works/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/AlchemistCxC/Pylon-co-works?sort=semver&label=release)](https://github.com/AlchemistCxC/Pylon-co-works/releases)

Pylon 是一个基于 [Agent Client Protocol（ACP）](https://agentclientprotocol.com/) 的桌面 Agent 工作台。

它连接本地 Agent，管理工作区与会话，并把对话、思考、工具、文件和权限请求放在同一个工作面中。Pylon 不提供模型，也不绑定某一家 Agent；能通过 ACP 接入的本地 runtime，都可以使用同一套界面。

📖 **[在线文档](https://alchemistcxc.github.io/Pylon-co-works/)**：发行包清单、Agent 检测器、插件系统（用户版/开发者版）、CLI 命令表与架构参考等篇目的导航与全文搜索版。

## 你可以用 Pylon 做什么

- 连接和切换多个本地 Agent runtime，为每个 Agent 保留独立会话。
- 按工作区管理项目目录，以及相关的技能、Hook 和 MCP 配置。
- 查看流式回复、可折叠 reasoning、工具输入输出、差异和运行状态。
- 浏览、搜索、编辑项目文件，并查看 Git 工作区状态。
- 使用终端风格或现代 GUI 风格的界面，调整字体、颜色、布局和呈现预设。
- 通过插件增加命令、工具、Hook、渲染器、设置页、Sheet 和 Gateway 路由。
- 用 CLI 或 Gateway 从本机脚本和消息平台控制正在运行的 Pylon。

## 立即开始

### 使用发布包

从 [Releases](https://github.com/AlchemistCxC/Pylon-co-works/releases) 下载 Windows 便携版，解压后运行 Pylon。首次打开后，在“设置 → Agent”中添加一个本地 Agent runtime。

Pylon 的发布包可以携带 Hermes 所需的 Git for Windows 运行时，因此使用 Hermes 时不必另行安装 Git 或 Bash。发布包的组成和校验步骤见[发行包清单](docs/说明书/Pylon-发行包清单.md)。

### 从源码运行

开发环境需要：

- [Bun](https://bun.sh/) ≥ 1.4
- Node.js LTS
- Rust stable
- Tauri 2 的系统依赖
- Windows WebView2

安装依赖并启动浏览器预览：

```bash
bun install
bun run dev
```

浏览器预览使用内置 mock 数据，不会连接真实 Agent，适合检查界面和渲染器。启动完整 Tauri 应用：

```bash
bun run tauri dev
```

## 第一次使用

1. 打开“设置 → Agent”，新增或编辑 Agent runtime，填写启动命令、参数和工作目录。
2. 在左栏选择 Agent；如果使用工作区模式，再选择一个工作区。
3. 在输入框发送第一条请求。Pylon 会创建 ACP session，并把首条请求发送给 Agent。
4. 在消息流中查看回复和工具活动。点击思考块或工具行可展开内容，长输出会在自己的区域内滚动。
5. 打开文件工作台浏览或编辑当前会话的工作目录。

如果首条请求失败，新建的会话会回滚。切换会话时，Pylon 先加载本地 canonical 历史，再接收实时事件，不会把旧会话的消息混入当前会话。

## 核心概念

| 概念 | 含义 |
| --- | --- |
| Agent runtime | 可以被 Pylon 启动并通过 ACP 通信的本地程序。 |
| Agent Profile | 某个 provider 的能力和默认配置视图。 |
| 工作区 | 项目根目录及其技能、Hook、MCP 等上下文的持久化实体。 |
| 会话 | 一个 Agent 的连续对话，包含 ACP session 映射和本地历史。 |
| Renderer Suite | 负责把 Workbench 语义数据呈现为界面的一组渲染器。 |
| 插件 | 在宿主授权 Scope 中运行、为 Pylon 增加能力的本地代码包。 |

工作区删除只会解除 Pylon 的上下文绑定，不会删除磁盘上的项目文件。reasoning 是否可见由 Agent 和协议决定；被隐藏的内容不会由 Pylon 还原。

## 界面与数据

Pylon 用同一套消息契约表示用户消息、助手回复、reasoning、工具活动和系统状态。界面模式与 Presentation Profile 只改变布局、字体、颜色、间距和指示器，不改变会话事实。

配置、Agent Profile、工作区、会话索引和 canonical transcript 分开保存：

- Tauri 模式由 Rust/SQLite 与前端存储协同完成。
- 浏览器预览使用 localStorage 作为演示存储。
- 设置页提供导入和导出入口；不要手工改写存储文件。

## 插件开发

插件是受信任的本地代码包，可以贡献：

- 命令、CLI 子命令和快捷操作；
- Agent 适配器、会话创建 Hook、工具和 MCP 配置；
- 消息内容渲染器、Renderer Suite、主题字段和设置页；
- 工作区 Sheet、左右栏面板、文件操作和 Gateway 路由。

插件在“设置 → 插件”中启用、停用、重新加载或卸载。插件可以执行本机代码，请只安装可信来源的插件。插件激活失败时，Pylon 会保留已保存配置并进入降级模式。

从 `@pylon/plugin-sdk` 开始开发插件：

```bash
bun run build:plugin-sdk
```

可运行的起步示例位于 [`examples/web-plugins/hello-starter`](examples/web-plugins/hello-starter)。SDK 用法见[插件系统开发者手册](docs/说明书/Pylon-插件系统说明书-开发者版.md)。

## CLI 与 Gateway

CLI 通过本机 IPC 控制已运行的 Pylon，可查询状态、切换会话、修改呈现设置、打开 Sheet 或触发插件命令。命令和参数见 [CLI 命令表](docs/说明书/Pylon-CLI-命令表.md)。

Gateway 是可选的消息转发层：外部平台的消息进入 Gateway 后映射到 ACP session，Agent 回复再转回外部平台。Gateway 仍遵守会话权限和 Agent runtime 配置。

## 开发与验证

常用命令：

```bash
bun run lint                 # ESLint
bun run test                 # Vitest 全量测试
bun run test:unit            # domains 与 infrastructure 单元测试
bun run build                # TypeScript + Vite 构建
bun run check:solid          # Solid 工作台边界与契约检查
bun run check:rust           # Rust 测试与构建
bun run check:frontend       # 前端完整门禁
bun run check:all            # 前端、Rust、Solid 全量门禁
```

按目录运行测试：

```bash
bun run test src/domains/theme
bun run test src/renderers/solid-workbench
```

修改渲染器时至少运行相关 Vitest、`bun run check:solid` 和 `bun run build`；修改 Rust/Tauri 时运行相关 Rust 测试和 `bun run check:rust`。

构建 Windows 便携版：

```bash
bun run release:portable
```

该命令会构建前端（含 WASM 计算核）、插件 SDK、Tauri 程序、Agent 检测器与 WebView2 MCP 调试工具，并生成便携包和校验文件。

## 代码地图

```text
src/main.solid.tsx                   应用入口与 bootstrap
src/kernel/                          Kernel、恢复和 Safe Mode
src/plugin-runtime/                  插件宿主、Scope 和注册表
src/domains/                         领域模型与状态同步
src/application/transactions/        跨领域应用事务
src/components/chat/                 聊天事件、消息行和输入组件
src/renderers/solid-workbench/       Solid 工作台与消息内容渲染
src/sheets/agent-workbench/          Agent 工作台 Sheet
src/infrastructure/                  Tauri 客户端与 canonical 事件仓库
src/plugins/product/                 第一方插件、样式和注册表
src/sdk/                             插件开发 SDK
src-tauri/pylon-acp/                 ACP 协议引擎核（客户端、传输与策略）
src-tauri/pylon-session/             会话存储核与 canonical journal
src-tauri/pylon-*/                   其余 workspace crate：Agent 目录、基础纯逻辑、canonical 契约、WASM 计算核
src-tauri/src/acp/                   ACP 宿主适配层（实例注册表，重导出 crate API）
src-tauri/src/session/               会话命令编排层
src-tauri/src/gateway/               Gateway 实例与平台路由
shared/                              前后端共享协议和类型
```

更完整的边界、数据流和扩展关系见[项目架构参考](docs/说明书/Pylon-项目架构参考.md)与[插件化前后端拓扑全图](docs/说明书/Pylon-插件化前后端拓扑全图.md)。

## 常见问题

### Agent 无法启动

检查可执行文件、参数、工作目录和权限；再查看运行日志或 Agent 设置面板中的启动诊断。先在终端直接运行同一条命令，可以区分 Pylon 配置问题和 Agent 自身问题。

### 会话恢复失败

先点击“重试恢复”。恢复仍失败时可以创建分叉会话；本地 canonical 历史会保留，恢复失败不会清空消息。

### 插件更新后仍显示旧版本

在插件页执行重新加载；开发时递增插件版本或 cachebuster，避免 WebView 缓存旧 bundle。

### 浏览器预览和 Tauri 窗口不一致

浏览器预览使用 mock 数据和浏览器存储，字体、系统能力和 ACP 生命周期与 Tauri 不同。发布前请在 Tauri 窗口中验证关键流程。

## 文档

- [项目架构参考](docs/说明书/Pylon-项目架构参考.md)
- [Agent 检测器](docs/说明书/Pylon-Agent-检测器.md)
- [CLI 命令表](docs/说明书/Pylon-CLI-命令表.md)
- [插件系统用户手册](docs/说明书/Pylon-插件系统说明书-用户版.md)
- [插件系统开发者手册](docs/说明书/Pylon-插件系统说明书-开发者版.md)
- [插件化前后端拓扑全图](docs/说明书/Pylon-插件化前后端拓扑全图.md)
- [发行包清单](docs/说明书/Pylon-发行包清单.md)

施工台账和过程资料位于仓库旁的外部 Docs 目录：

- [问题台账](../Docs/Pylon-问题台账.md)
- [下一阶段问题清单](../Docs/Pylon-下一阶段问题清单.md)

## License

Pylon is licensed under the GNU Affero General Public License version 3 only
(`AGPL-3.0-only`). See [LICENSE](LICENSE). Copyright (c) 2026 AlchemistCxC
and Pylon contributors. Third-party notices and source attributions are
retained in [NOTICE](NOTICE), [LICENSES](LICENSES/) and the vendored source.
