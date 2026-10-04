# Pylon Context

Pylon 是以 ACP 连接多个本地 Agent runtime 的桌面工作台；配置实例、provider 基线与实时协议能力必须保持清晰分层。

项目结构、Kernel/插件层归属、关键调用链与定向阅读入口见 [`docs/说明书/Pylon-项目架构参考.md`](docs/说明书/Pylon-项目架构参考.md)。后续任务默认先读该文档并做局部核验，不重新进行全量架构侦察。

分块维护时先看 [模块维护地图](docs/说明书/Pylon-模块维护地图.md) 与 [开发规范](.agents/dev-standards.md)：目录归属由可执行清单核对，命名与代码规则随代码维护；协作流程见 [AGENTS.md](AGENTS.md)。

Kernel 加固的已确认产品决策、问题编号与施工进度见 [`Docs/Archive/Pylon-Kernel-施工台账.md`](../Docs/Archive/Pylon-Kernel-施工台账.md)。

## Agent language

**Agent Catalog**:
版本化的第一方 provider 基线，记录身份、受控探测入口、协议默认值、交互能力和工具语义；它不是用户实例配置，也不覆盖 ACP 实时协商结果。
_Avoid_: Agent dictionary, detector table, builtin descriptor list

**Agent Profile**:
某个 provider 的有效特性视图，按 Agent Catalog 基线、Agent Instance 显式覆盖、ACP 实时协商依次收敛。
_Avoid_: Agent definition, provider config

**Agent Instance**:
`agents.yaml` 中可启动的具体 Agent 配置；同一 provider 可以有多个 Agent Instance。
_Avoid_: Agent Profile, runtime candidate

**Runtime Candidate**:
Native 受控探测发现但尚未导入为 Agent Instance 的临时结果。
_Avoid_: detected Agent, auto-imported Agent

**periId**:
ACP 会话的 remote binding ID（vendor 侧会话句柄）；只记录最近一次 remote binding，**不参与 Session identity**——durable owner 身份由 `(profileId, agentId, source)` 判定。Rust 侧拼写 `peri_id`；域代码注释中出现的 `remoteSessionId` 为同物别名，新代码统一用 `periId` 对齐 wire 契约。
_Avoid_: remoteSessionId, session external id

## Rendering language

渲染引擎长程施工的唯一入口为 `G:\Project\prism-team-workdir\Docs\Archive\渲染引擎施工\00-唯一入口台账.md`；架构、WI 状态和代码施工方式不得从已失效的仓内旧方案重新推导。

当前前后端插件依赖与 Renderer Suite 规划接缝见 [`docs/说明书/Pylon-插件化前后端拓扑全图.md`](docs/说明书/Pylon-插件化前后端拓扑全图.md)；图中 planned 节点不得当作当前实现。

**Presentation Profile**:
一组可持久化、可由插件贡献的视觉与交互令牌，描述消息布局、输入形态、控制中心材质和配套图形资产；它不决定渲染引擎（例如 Solid 或隔离式 Surface，外部引擎不限）。
_Avoid_: renderer preset, terminal renderer

**Renderer Engine**:
把宿主语义数据挂载为可见 UI 的技术适配器，例如 Solid 或隔离式插件 Surface（外部引擎不限）；引擎与 Presentation Profile 正交。
_Avoid_: visual style, theme preset

**Workbench Renderer**:
能够接管 AgentSheet 工作区主体（历史消息、流式输出、任务与输入）的渲染贡献，同时遵守宿主提供的语义数据、命令与生命周期边界。
_Avoid_: message row renderer, skin

**Renderer Suite**:
用户选择、热更新和故障回退的整套渲染原子单位；声明 Workbench factory、兼容性、required Render Kinds、基础 Renderer Slots、fallback 与设置 schema。Suite 不拥有 WorkbenchDocument，也不替换 Kernel。
_Avoid_: message renderer, presentation profile, interface mode

**Renderer Slot**:
Renderer Suite 内针对一个或多个 Render Kind 的具体视觉 adapter；第三方 overlay 必须显式声明目标 Suite，不能靠全局优先级跨 Suite 混搭。
_Avoid_: renderer suite, render kind, UI component

**Workbench Host Port**:
宿主提供给内置和第三方 Renderer Suite 的稳定 interface，组合只读 WorkbenchDocument、resolved appearance、capabilities、namespaced Session UI、semantic commands 与 diagnostics；不暴露 controller、journal、provider raw 或 Tauri invoke。
_Avoid_: plugin event bridge, store bag, renderer context

**Renderer Activation Snapshot**:
由唯一 RendererRegistry、Interface Mode 默认值与用户 Suite 选择派生的 immutable 活动组合，包含确定的 Suite、Render Kinds、Renderer Slots 和诊断；它可丢弃、不可持久化，不是第二个 registry。
_Avoid_: renderer registry, renderer state store

**Event Provenance**:
canonical journal 中事件的来源与可信度描述。`local-observed/authoritative` 只能由 Kernel live ingest 产生；Agent replay 仅能在可信 journal 为空时作为 `recovery-import/unverified` 写入，不能因为进入 SQLite 就提升可信度。
_Avoid_: replay completeness, SQLite means trusted

**Renderer Settings Schema**:
由 Workbench Renderer 或 Render Kind 声明的可序列化表现设置 interface，包含字段、候选列表、控件方式、组合分组与条件；宿主据此生成设置 UI，renderer 只消费解析后的 appearance。
_Avoid_: plugin settings page, hard-coded renderer controls
