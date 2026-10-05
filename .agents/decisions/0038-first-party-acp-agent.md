# ADR-0038 一等自研 ACP 编码 agent（prometheus，独立仓）

- **日期**：2026-10-05
- **状态**：已采用（方向裁决于 issue #556 由维护者确认；实现细化默认值经维护者 2026-10-05 追认：「裁决项按照推荐来」，下表「待复核」标注解除）

## 背景与约束

Pylon 后端作为 ACP 宿主（引擎核 / canonical journal / 审批线 / 锁面）进入成熟期，但宿主只认识外部 agent（Peri / Hermes），方言支持全是被动适配（provider_adapter 方言表、peri 私有扩展通道）。自研 agent 可从第一天起说干净的官方 spec，不再积累方言代码。

约束（issue #556 已裁决）：通用编码 agent 定位（目标是日常主力）；Rust + 官方 `agent-client-protocol` crate（宿主钉 2.2.0、只收协议 v1）；独立仓库；与 Pylon 的耦合只允许指向零 tauri 纯库 crate；单 agent 实现（非多 agent 编排）。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 继续被动适配外部 agent 方言 | 方言债持续累积；宿主测试面（fake-agent 场景）随方言膨胀 |
| 依赖 Peri 整体（fork / 依赖其 crate） | 42 万行 / 15 crate，peri-acp 名义薄壳实为 5 万行、peri-middlewares 9.6 万行巨石袋；闭包类型注入（StageBuildFn）复杂；TUI/LSP/MCP 等大量 v1 非目标 |
| 用官方 LLM SDK crates（anthropic / async-openai） | 流式事件形状受 SDK 制约，thinking 块与 usage 保真度降级；Peri 先例证明手写 SSE 层约 4k 生产行可控 |

## 决定

独立新仓 **prometheus**（`G:\Project\prism-team-workdir\prometheus`，Apache-2.0；GitHub 推送时机待维护者定），Rust workspace 五 crate，契约先行后 4 agent 并行施工：

```
prom-core（零 IO 契约：Model/BaseTool/ThreadStore trait、EngineEvent、Settings、AgentCaps）
├── prom-model    LLM 层：Anthropic 原生 + OpenAI 兼容双实现，reqwest+手写 SSE，重试=首个可见 delta commit
├── prom-tools    read/write/edit/bash/glob/grep + peri-process 移植（Job Object/CREATE_NO_WINDOW）+ 并发分发
├── prom-store    SQLite（rusqlite bundled）两表 + 回放组装 + frozen snapshot write-once
└── prom-acp      官方 SDK Agent::builder + Stdio、ReAct 引擎、审批 broker、bin
```

实现细化默认值（维护者 2026-10-05 追认按推荐执行；模块化实现，后续改判成本低）：

| 项 | 采纳值 |
| --- | --- |
| LLM 抽象 | 双原生 + 手写 SSE，零 LLM SDK |
| 持久化 | SQLite rusqlite(bundled)，threads+messages 两表 |
| 权限档位 | 两档 Default/Bypass，经官方 configOptions/modes 呈现 |
| 私有 caps | v1 零私有 caps——title/usage/回放全走官方 schema；PeriCaps 式 fail-closed 框架预留空载 |
| 配置形状 | TOML 单文件 + API key 环境变量优先 |
| Pylon 耦合 | 零依赖（官方 ACP crate 足够；issue 仅约束「若有耦合只能指向纯库 crate」） |
|ACP 版本钉 | `agent-client-protocol =2.2.0` / `agent-client-protocol-schema =1.9.1` 与宿主逐字节对齐 |

运行纪律（spec #556 细化）：stdout 只准 JSON-RPC；prompt/load spawn 化保 cancel 可达；未知方法 -32601；工具自带执行（宿主只承担审批 UI）；bash 走进程组（Job Object + CREATE_NO_WINDOW），终止请求 ≠ 完成。

## 后果

- 正面：Pylon 侧零代码改动达成（issue 预期成立）；方言表不再增长；协议行为以 golden wire 基线（6 场景 13 帧）逐字节钉死，SDK 升级漂移 CI 可拦；单测 203 全绿 + clippy 零诊断 + 实机验收通过（握手门禁 44ms、审批卡→真 bash→流式回流全链）。
- 负面：自持 LLM/工具/持久化整栈的维护面（约 1.2 万行新代码）；真 LLM 实弹验收待 API key。
- 风险：官方 ACP crate 处于 2.x 演进期，升版需连带重录 golden 基线并核对 wire 变更点；Peri 移植代码（peri-process、部分契约形状）须保持 Apache-2.0 归属声明（NOTICE 已置）。

## 证据

- issue 方向裁决：Teens-in-Times/Pylon-co-works#556（正文「方向裁决：Pylon 自带一个一等 agent（已确认）」）
- 实现记录与实机验收数值：`.agents/records/556-prometheus-agent.md`
- 宿主接入事实：`src-tauri/src/lifecycle/connection_test.rs:224`（握手门禁）、`src-tauri/pylon-core/src/provider_adapter.rs:29-63`（未知 provider 零方言）、`src-tauri/pylon-acp/src/replay.rs:123-146`（回放边界）
- Peri 参照：`F:\A-I\Agent\Peri\source`（peri-model 错误学/重试语义、peri-process 440 行移植源）
