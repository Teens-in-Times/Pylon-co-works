/** Read-only maintenance inventory. Module ownership is architectural, not a list of people. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

export const moduleDefinitions = [
  { id: 'contracts', roots: ['src/contracts/', 'src/sdk/'], responsibility: '公开语义与插件 SDK；兼容性在调用者边界验证' },
  { id: 'domain', roots: ['src/domains/'], responsibility: '领域模型、投影与策略；不新增 UI / IPC / 全局 store 依赖' },
  { id: 'application', roots: ['src/app/', 'src/application/', 'src/kernel/'], responsibility: '应用启动、恢复与事务；不等同于全部概念 Kernel' },
  { id: 'infrastructure', roots: ['src/infrastructure/'], responsibility: 'IPC、持久化、事件传输与系统适配' },
  { id: 'plugin-host', roots: ['src/plugin-runtime/'], responsibility: '扩展注册、激活、隔离、授权和资源 Scope' },
  { id: 'product-plugins', roots: ['src/plugins/'], responsibility: '第一方产品包与贡献实现；plugins/core 仍属产品层' },
  { id: 'workbench-host', roots: ['src/host/', 'src/application/agent-workbench/', 'src/sheets/agent-workbench/'], responsibility: 'Renderer Suite 宿主、会话绑定与命令编排；文档状态所有者（#486 项1：会话运行时归位 application，视图件留守 sheets）' },
  { id: 'renderers', roots: ['src/renderers/'], responsibility: '文档到 UI 的呈现与交互适配；消费 Host Port' },
  { id: 'workspace-ui', roots: ['src/sheets/', 'src/workspace-sheets/', 'src/components/'], responsibility: 'Sheet、设置、工作区与既有组件；chat 目录含待迁移的编排' },
  { id: 'cli', roots: ['src/cli/'], responsibility: 'CLI 语法、执行与领域命令适配' },
  // #228 批次B：三源导出采集器自 src/obs04/ 下沉 src/domains/export/（归 domain 根）。
  // 结构全修批：obs04~07 四个顶级散目录收敛 src/devtools/obs/（安装样板 devTriggerKit.ts）。
  // css04/cwd02 已删除（零引用死代码），cwd wire 行为锁迁 infrastructure/acp/__tests__/。
  { id: 'diagnostics', roots: ['src/devtools/obs/'], responsibility: '观测与诊断取证（DEV 触发器在 main 动态接入）；三源导出采集已下沉 src/domains/export/' },
  { id: 'layout-policy', roots: ['src/css01/'], responsibility: '历史样式取证基线；保留调用语义后再迁移' },
  { id: 'shared-utilities', roots: ['src/utils/'], responsibility: '已有窄工具函数；新代码优先归属具体能力模块' },
  { id: 'test-support', roots: ['src/test-utils/'], responsibility: '测试共享支撑（mock 形状、fixture 工厂）；仅被测试代码 import，不进生产构建' },
  { id: 'demo', roots: ['src/demo/'], responsibility: '浏览器演示数据；不得把演示验证当作原生链路证据' },
  { id: 'frontend-root', roots: ['src/*', 'src/presets/', 'src/zones/'], responsibility: '旧根级 store、schema、入口和公共策略；按真实调用者逐步下沉' },
  { id: 'rust-acp', roots: ['src-tauri/src/acp/', 'src-tauri/src/dispatcher/', 'src-tauri/src/lifecycle/'], responsibility: 'ACP 宿主适配：实例注册与 harness 依赖型表征测试' },
  // #247：协议引擎核/存储核独立 crate；依赖方向 acp→core→foundations、session→core。
  { id: 'rust-session', roots: ['src-tauri/src/session/'], responsibility: '会话命令编排：create/prompt/persist/inspector/expiry 与 owner 解析' },
  { id: 'rust-acp-engine', roots: ['src-tauri/pylon-acp/src/'], responsibility: 'ACP 协议引擎核：engine/client/negotiated/replay/wire_trace/policies' },
  { id: 'rust-session-storage', roots: ['src-tauri/pylon-session/src/'], responsibility: '会话存储核：event_repo/msg_repo/retention/turn_rollup，禁止触达 tauri' },
  { id: 'rust-host', roots: ['src-tauri/src/'], responsibility: 'Tauri 注册、native adapters、文件/终端/Gateway/插件服务' },
  { id: 'rust-core', roots: ['src-tauri/pylon-core/src/'], responsibility: '可复用 Agent catalog、检测与 preflight 能力' },
  { id: 'rust-foundations', roots: ['src-tauri/pylon-foundations/src/'], responsibility: '跨宿主基础类型与策略' },
  { id: 'pet-core', roots: ['src-tauri/pet-core/src/'], responsibility: '独立宠物领域能力' },
  // #220 WP1：canonical 事件 wire 契约的单源（TS 侧词表由它生成）；被写入侧
  // （rust-session 的 event_repo）与 WASM 计算核同时消费。
  { id: 'rust-canonical-types', roots: ['src-tauri/pylon-canonical-types/src/'], responsibility: 'canonical 事件类型词表、判别符映射与 identity 推导的单源' },
  // #220：前端计算核（Rust/WASM）。纯函数——不读时钟/store/registry、不做 IO、
  // 不发明活性判定；编排与 DOM 留在 JS 侧。
  { id: 'rust-compute', roots: ['src-tauri/pylon-compute/src/'], responsibility: '前端计算核：投影折叠与流式文本管线的计算层（wasm-bindgen 出口）' },
  // #220 WP4：markdown 引擎（comrak）。#241 起代码高亮已不在本 crate——syntect 语法
  // 机器连同 `gen/` 资产生成器、vendored tmLanguage 与 TS↔Rust 差分工具一并退役，
  // 高亮改由前端 Lezer 承担。`parity/` 只剩语料与 Rust 快照（JSON，不计行），
  // 供 vitest 侧 markdown parity 门禁消费。
  { id: 'rust-markdown', roots: ['src-tauri/pylon-markdown/src/'], responsibility: 'markdown 解析的计算层；整块进/整块（行数组）出' },
  { id: 'markdown-parity-tooling', roots: ['src-tauri/pylon-markdown/parity/'], responsibility: 'markdown 语料与 Rust 快照，供 parity 门禁消费；无 JS 源，故计 0 行' },
  // #382：测试夹具独立 crate（feature `test-agent` 门控）。主 crate 里的同包 bin 会被
  // Cargo 的"包内 bin 隐式链接本包 lib"规则拖去编译整棵 Tauri 依赖树，故单独成 crate。
  { id: 'rust-fake-agent', roots: ['src-tauri/pylon-fake-agent/src/'], responsibility: '测试专用假 ACP agent 夹具；不随发行包发布，不参与生产运行时' },
  // #364：外部 CLI 历史解析。只产 IR（session/update 线形状）——零 tauri、零
  // rusqlite；落库由宿主经 pylon-session 的 ingest_external_history 完成。
  { id: 'rust-agent-history', roots: ['src-tauri/pylon-agent-history/src/'], responsibility: '各 Agent CLI 原生历史会话的解析 IR（Claude Code tracer）；只产 IR 不写库' },
  { id: 'rust-build', roots: ['src-tauri/*'], responsibility: '原生构建入口脚本；不属于运行时模块' },
  { id: 'tooling', roots: ['scripts/'], responsibility: '开发、校验与发布脚本；不作为产品运行时 import 来源' },
] as const

const moduleRoots = moduleDefinitions.flatMap(module => module.roots.map(root => ({ id: module.id, root })))
  .sort((left, right) => right.root.length - left.root.length)

export function isMaintainedSource(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?|rs|py|ps1|sh)$/.test(path)
    && !/(?:^|\/)(?:__tests__|__fixtures__|test|tests|vendor|target|node_modules)\//.test(path)
    && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
    && !/\.d\.[cm]?ts$/.test(path)
    && !path.startsWith('src-tauri/resources/')
    && /^(?:src\/|src-tauri\/|scripts\/)/.test(path)
}

export function moduleFor(path: string): string | undefined {
  return moduleRoots.find(({ root }) => root.endsWith('*')
    ? path.startsWith(root.slice(0, -1)) && !path.slice(root.length - 1).includes('/')
    : path.startsWith(root))?.id
}

async function audit() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(isMaintainedSource)
  const files = [...new Set(paths)].filter(path => existsSync(resolve(root, path)))
    .map(path => ({ path, module: moduleFor(path), lines: readFileSync(resolve(root, path), 'utf8').split('\n').length }))
  const unmapped = files.filter(file => !file.module)
  const modules = moduleDefinitions.map(module => ({ ...module, files: files.filter(file => file.module === module.id).length }))
  const report: Record<string, unknown> = { modules, sourceFiles: files.length, unmapped, largestFiles: files.toSorted((a, b) => b.lines - a.lines).slice(0, 25) }
  if (process.argv.includes('--naming')) {
    const eslint = new ESLint({ cwd: root })
    const results = await eslint.lintFiles(files.filter(file => /^src\/.+\.tsx?$/.test(file.path)).map(file => file.path))
    report.namingFindings = results.flatMap(result => result.messages
      .filter(message => message.ruleId === '@typescript-eslint/naming-convention')
      .map(message => ({ path: relative(root, result.filePath).replaceAll('\\', '/'), line: message.line, message: message.message })))
  }
  console.log(JSON.stringify(report, null, 2))
  if (unmapped.length > 0) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await audit()
