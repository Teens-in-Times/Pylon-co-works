# Dev Record — #556 自研 ACP 通用编码 agent（prometheus）

## 元信息

- issue：Teens-in-Times/Pylon-co-works#556（enhancement，方向裁决见 issue 正文）
- 分支：**Pylon 侧零代码改动**（本记录与本仓 coord 文件是仅有的本仓提交）；代码在**仓外独立仓** https://github.com/Teens-in-Times/prometheus（私有，本地 `G:\Project\prism-team-workdir\prometheus`，main 已推送）
- 提交范围（新仓）：`c636b35..0998c5a`（main，含 ci.yml 与 CI 首跑三修复）
- 日期：2026-10-05
- 施工方式：主会话落契约 crate（prom-core）→ 4 子 agent 并行施工（prom-model / prom-tools / prom-store / prom-acp）→ 主会话集成 + 实机验收

## 目标与范围

按 issue 口径全量施工 M0–M3 + golden wire 基线：echo 打通（M0）→ 真 LLM 流式（M1）→ 工具循环 + 宿主审批卡 + cancel（M2）→ session/load 全量回放 + 模型/模式目录 + frozen snapshot（M3）。

**不做**（v1 明确清单照 issue）：TUI、LSP、MCP 客户端、多 agent 编排、cron、插件系统、JS runtime、web PTY、云同步、Langfuse、权限 LLM 分类器；另加：auto-compact（只做 token 统计 + 阈值日志）、与 Pylon crates 的任何依赖耦合（零依赖）。

## 改动清单（Pylon 仓）

| 文件 | 性质 |
| --- | --- |
| `.agents/L.md` | #556 施工范围声明（完工已撤条） |
| `.agents/records/556-prometheus-agent.md` | 本记录 |
| `.agents/decisions/0038-first-party-acp-agent.md` | ADR：一等自研 agent 路线登记 |
| `.agents/spec/556-prometheus-agent-spec.md` | 规格文档（一次性，不入库，未提交） |

**`src/`、`src-tauri/` 零改动**——issue 的「Pylon 侧零代码改动」预期成立。

改动清单（prometheus 新仓，87 文件，节选）：

| 区块 | 性质 |
| --- | --- |
| `crates/prom-core/src/`（model/tools/store/events/config/caps/error + lib） | 新增，契约 crate，主会话写 |
| `crates/prom-model/src/{sse,transport,retry,anthropic,openai_compat,lib}` | 新增，Agent B |
| `crates/prom-tools/src/{process/*,tools/*,registry,dispatch,lib}` | 新增，Agent C（process 两文件系 Peri peri-process 移植，Apache-2.0 头保留） |
| `crates/prom-store/src/{sqlite,replay,lib}` | 新增，Agent D |
| `crates/prom-acp/src/{server,engine,session,permission,mapper,replay,config,logging,assemble,main}` + `tests/{wire,golden,common}` | 新增，Agent A（失活后主会话接手收尾） |
| `tests/golden/*.jsonl`（6 场景 13 帧） | 新增，golden wire 基线 |

## 方案要点

- **契约先行**：prom-core 先行落地（Model trait + 6 变体流事件、BaseTool、ThreadStore、EngineEvent、Settings、AgentCaps fail-closed 框架），4 agent 按装配接缝签名并行，互不越界；集成期零签名漂移。
- **官方 SDK 走正门**：`Agent::builder()` + `Stdio` + `MatchDispatchFrom` DSL（非 Peri 的 DTO-only 用法）；prompt/load handler spawn 化保 cancel 可达；未知方法 **-32601**（宿主 session/close 防御降级与 session/list 探针的判定码）。
- **LLM 层**：Anthropic Messages 原生 + OpenAI 兼容双 adapter，reqwest+手写 SSE，重试语义 = 首个可见 delta 前 commit 静默重试、之后 Interrupted 不重放；HttpTransport seam 供测试 mock。
- **工具层**：六件套（read/write/edit/bash/glob/grep）+ cwd 沙箱（canonicalize 前缀裁决）+ peri-process 移植（挂起态入 Job、CREATE_NO_WINDOW、终止请求 ≠ 完成）+ 并发分发（`select!{biased; cancel, timeout, invoke}` 完成即发事件、结果保序）。
- **持久化**：rusqlite(bundled) 两表 + WAL；消息版本化 JSON envelope；`write_frozen_snapshot_if_absent` SQL 级 write-once；seq 升序 = 回放顺序真源。
- **权限**：两档 Default/Bypass 经 configOptions(mode) + availableModes 呈现；Default 对写/bash 逐次 `session/request_permission`（allow_once/allow_always/reject_once/reject 四 option，allow_always 升级会话态），agent 侧 300s 超时=拒绝、宿主 cancelled=拒绝。
- **title/usage 全走官方通路**：`session_info_update{title}` + `usage_update{_meta.model}`；宿主把人格前言与用户输入拼进同一文本块（`---` 独立行分隔），标题取最后一个分隔行之后的文本。

## 验收标准与结果

| 验收项（issue 验收建议） | 结果 |
| --- | --- |
| M0：agents.yaml 手填 → 测试连接 → 配置保存过 #422 门禁 → prompt 流式回显 | ✅ `test_agent_candidate` 真机 ok=true / durationMs=44（provider=prometheus 零方言路径）；流式回合见下 |
| M1：text/thinking/usage 流进时间轴 | ✅ 实机：agent_message_chunk×2 + usage_update（上下文计 `0.0k/200.0k` 读数正确）；thinking 流 fixture 级单测覆盖（Anthropic thinking/signature delta、OpenAI reasoning_content） |
| M2：审批卡 + 批准/拒绝语义 + cancel 中途取消 | ✅ 实机审批卡（bash: echo prometheus-live，四按钮）→ Allow once → 真实 bash 执行 → tool_call/tool_call_update 卡（已完成）；cancel 路径单测 + wire 测试 + golden 基线覆盖 |
| M3：重启 session/load 回放复活 + 模型/模式目录可切换 | ✅ golden `load` 场景（回放先于响应逐字节基线）；实机：进程崩溃→宿主 auto-reconnect→session/load 回放 messages=1/2（日志）；configOptions（model+mode 两档）实机渲染（mock 模型选择器 + default 徽标） |
| golden wire 基线（CI 拦 SDK 升级漂移） | ✅ 6 场景 13 帧入库，录制/比对双模（`PROMETHEUS_GOLDEN_WRITE=1` 重录） |
| 单测/门禁 | ✅ `cargo test --workspace` **203 passed / 0 failed**；`cargo clippy --workspace --all-targets -- -D warnings` 零诊断；`cargo fmt --check` 干净 |
| stdout 纪律 | ✅ golden 基线逐字节隐式覆盖（stdout 每行均合法 JSON-RPC）；日志落 `logs/prometheus.log` |

## 测试处置

Pylon 仓：无测试修改（零代码改动）。prometheus 新仓 203 测试全部新增（core 25 / model 44 / tools 71 / store 10 / acp lib 45 + wire 4 + golden 1 + 其他 3）。

## 证据

- 新仓提交：`c636b35`（脚手架+契约）→ `c3551a8`（四 crate 全量）→ `7e568bf`（golden）→ `bd74dc7`/`acdde44`（clippy 清偿）→ `824f907`（实机修复三连）→ `8fbe3a4`（标题前言剥离）→ `8f023e2`（README）
- 实机握手：`test_agent_candidate` 返回 `ok=true, durationMs=44`，launchPlan provider=prometheus（catalog 未声明 → 零方言覆盖路径，`explicit-override` 诊断）
- 实机工具回合：审批卡（toolcallId call-live-1，Allow once/Allow always/Reject once/Reject 四钮）→ 批准后 `Prometheus-live (bash) — 已完成` 工具卡 + 流式文本「mock 第二回合：工具输出=[prometheus-live]」（真 bash 输出回流 LLM 后播报）；SQLite `threads.fee6e2ea…` + messages 4 行（user/assistant_text/tool_use/tool_result 各 1）
- mock LLM 与驱动脚本：`D:\pylon-tmp\prom-accept\`（mock_llm.mjs / smoke.mjs / agents.yaml / config.toml，验收基础设施，可复跑）
- 宿主侧日志：`agent_stderr_echo` 捕获 agent panic stderr → 触发 crash-reconnect → session/load 复活（宿主韧性链路顺带实测）

## 实机验收揪出的缺陷（均已修复并带回归测试）

1. **CJK 字节截断 panic**（`String::truncate(48)` 切多字节字符）：ASCII 单测全绿、中文首条消息即崩（`assertion failed: self.is_char_boundary`）。修：`prom_core::truncate_chars` 字符安全截断，prom-acp 三处 title 截断同批换用。
2. **未知方法错误码 -32603 → -32601**：宿主 session/close 防御降级、session/list 探针按 -32601 判定。修：`Error::method_not_found()`。
3. **标题取到宿主前言**：Pylon 把人格前言 + `---` + 用户输入拼同一文本块，标题变成「你是 XXX 助手…」。修：取最后一个分隔行之后文本。

## CI 首跑揪出的缺陷（环境相关，均已修复；新仓 CI windows+ubuntu 双作业全绿）

1. **golden 基线 CRLF**：无 `.gitattributes` 时全新 checkout 被 autocrlf 转 CRLF，逐字节比对必炸（CI windows 实证：仅 golden 挂，其余全绿）。修：`* text=auto eol=lf` + renormalize。
2. **路径字面量比对 vs 8.3 短路径**：CI 的 tempfile 给长路径（`runneradmin`）、canonicalize 返回短路径（`RUNNER~1`）。生产裁决两侧同走 canonicalize 本就自洽，测试期望改为与实现同构的规范化管道（含 deverbatim）。
3. **Linux zombie 挂死（最有价值的一个）**：SIGKILL 后直接子进程先变 zombie，含 zombie 的组 `kill(-pgid,0)` 返回 0 而非 ESRCH——bash 工具超时/取消路径的 `wait_for_exit` 纯轮询在 Linux 上无限循环（CI ubuntu 三个 run 全部 40–75 分钟挂死；本机 Windows 的 Job accounting 掩盖了它，Peri 移植的两条 unix 测试恰好先 reap 也未暴露）。修：`wait_for_exit(&mut Child)` 轮询里 `try_wait` 收尸；CI ubuntu 作业随即通过（热缓存 2m04s 全 run 绿）。另加作业级 timeout 护栏（windows 20m / ubuntu 30m）防挂死占满 6h 默认。

## 与 spec 的偏差

- bash `run_in_background` 参数：拒绝（InvalidInput）而非降级前台执行——v1 无后台任务表，假后台比报错更有害。
- 非裸 HTTP 状态的 `{"error":{"message"}}` 响应：408/429/5xx → Provider（可重试）、其余 → Other（不可重试），重试分类与裸 HttpStatus 一致（否则 400 会空转重试 6 次）。
- `ModelStream` 取消唤醒用观察者任务 + waker 登记（poll 时同步检查不足以唤醒安静流）——spec 未细化的契约级补全。
- thinking 流保真增补 `ThinkingDelta.signature_delta`（Anthropic signature 回传多轮必需）。
- 4 个子 agent 中 prom-acp 中途失活（600s 无活动），代码基本写完，收尾（config env 测试、wire 基线、装配核对）与两处集成修复由主会话完成。

## 未解问题

1. **GitHub 建仓推送**：✅ 已完成——`Teens-in-Times/prometheus`（私有，main 已推送，CI：windows 测试+clippy+fmt / ubuntu 测试兼验 unix 分支）。维护者追认授权（2026-10-05「裁决项按照推荐来」）。
2. **真 LLM 实弹验收**：部分达成——本机 Claude 网关凭证（ANTHROPIC_AUTH_TOKEN + 127.0.0.1:18080）存在但网关进程未运行，transport 连接失败；**重试链路因此获得真实验证**（6 次尝试、指数退避 4.4s→9.9s→17.4s→RetryExhausted→engine model_error stop→宿主 -32603，行为与设计逐项一致）。真回合冒烟脚本已备好（`D:\pylon-tmp\prom-smoke\real_smoke.mjs`，凭证只进环境变量），网关在线时可直接复跑。
3. **ADR-0038 细化默认值**：✅ 维护者追认按推荐执行（LLM 双原生 / SQLite / 两档权限 / 零私有 caps / TOML 配置），ADR 状态行已更新。
4. **Pylon 侧发现（不改本仓代码，另行登记）**：前端时间轴把官方 `current_mode_update` 渲染成「未识别的 current_mode_update 事件」（`wireSemanticCorrespondence.ts` 标准变体表无此键；后端 `dispatcher/reactions.rs` 有消费）。已登记 #557。

## 并行交集

本仓仅 coord/records/decisions 追加，未碰任何生产文件与他在途文件域（decisions/0035、records/515 的在途 hunks 保持原样未动）。仓外新仓为独立目录，无共享面。
