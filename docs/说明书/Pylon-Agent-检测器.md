# Pylon Agent 检测器

`pylon-detect` 是不依赖已启动桌面应用的本地 ACP Agent 检测程序。它与设置页的“重新探测”按钮调用同一个 `pylon-core` 检测核心（首次进入 Agent 配置页会自动探测一次）；两条入口共享 `shared/agent-catalog.json` 的 provider、启动命令和配置证据规则。差异在缓存层：GUI 侧的 `detect_agent_runtimes` 命令经 `DetectionSnapshot` 三态 TTL 缓存（success 600s / unknown 60s / failure 15s）返回，可强制刷新、可用 `cancel_detection_refresh` 取消在途刷新，返回体带 `cached` 与 `probeMs`（P74 B0）；CLI 每次执行都是全新扫描，不读缓存。

设置页以“确认入口 → 验证并导入 → 开始对话”呈现发现结果。候选选择列表区分待验证、启动异常、连接未通过与已添加；同一提供方的备用入口在准备面选择。默认只显示名称与启动入口，标识、完整路径、参数和提供方在高级配置中编辑；扫描报告与安装帮助单独展开。验证失败保留草稿和具体原因，高置信候选的显式未验证导入保留在失败恢复选项中。保存完成后由用户点击“使用此 Agent”连接并打开对话，不自动打断当前会话。

手动添加也先对填写的启动配置完成真实 ACP 验证，通过后才保存；失败不写配置，卸载后的迟到验证不会继续创建。已配置 Agent 默认展示摘要与打开对话入口，编辑、重启、默认值和删除在“管理”中展开。管理展开状态按 Agent 标识保留，配置列表刷新不会把正在查看的管理区收起。

```text
pylon-detect [--json] [--detector <id>] [--home <path>] [--search-root <path>]
pylon-detect --diagnose
pylon-detect help | --help | --version
```

- 不传参数时检查 PATH 与有限的平台安装目录，并从当前用户目录读取配置证据。
- `--detector` 可重复，只运行指定 detector。
- `--home` 覆盖配置目录所属的用户目录，便于诊断和自动化测试。
- `--search-root` 可重复；一旦提供，只在这些目录中找可执行文件，不再扩展平台目录或读取 Windows App Paths。
- `--json` 输出稳定的 `{ "report": { "candidates": [...], ... }, "diagnostics": [...], "preflight": [...] }` 文档（candidates 在 `report` 内；GUI 命令的返回体则是把检测快照拍平、顶层即 `candidates`，另带 `cached` 与 `probeMs`）。
- `--diagnose` 打印一份可直接复制上报的诊断报告：环境部分（含 PATH 注入差异等）来自 `agent_diagnostics`，per-provider 部分是 preflight 检查项与失败原因。

## 诊断的失败可解释性（#325）

探测失败以 `diagnostics[]` 上报，每条带 `code`（机器可读，如 `version_probe_spawn_failed`、
`version_probe_timeout`）、`stage`、`message`（含系统级原文）与 `retryable`。**#325 起另有结构化归因**：

- `candidateId`：该诊断属于哪个候选（对齐 `candidates[].candidateId`）。探测类诊断必定有值；
  选择/预算类诊断（`unknown_detector_id`、`candidate_limit_reached`、扫描级
  `detection_budget_exhausted`）没有候选上下文，为 `null`。
- `executable`：被探测的可执行文件绝对路径。探测类诊断必定有值；预算耗尽这类「未真正探测」
  的诊断即便发生在某个候选的探测包装里也不带路径——那是对全局预算的陈述，不是关于这个
  可执行文件的事实。

前端据此把失败原因挂到对应的 Agent 卡（此前只能从 `message` 里正则抠路径），并展示
「码 + 一句话解释」（解释取自前端单源码表 `src/errorCodeExplanations.ts`）。设置页的
「重新探测」与卡片上的「重试探测」都**强制刷新**（`force: true`）——否则可能命中 TTL 缓存，
用户点了没有实际重探。

配置证据只读取 catalog 明确列出的相对文件，单文件上限 256 KiB，不递归扫描。JSON/YAML 解析成功后仅输出命中的字段名（例如 `provider`、`model`），不输出字段值，因此 API key、token 和模型服务凭据不会进入 GUI、CLI 结果或诊断报告。

开发环境运行：

```text
cargo run --manifest-path src-tauri/Cargo.toml --bin pylon-detect -- --help
cargo run --manifest-path src-tauri/Cargo.toml --bin pylon-detect -- --json
cargo run --manifest-path src-tauri/Cargo.toml --bin pylon-detect -- --diagnose
```
