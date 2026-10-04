#!/usr/bin/env node
// #488 批②：await-holding 豁免的机械保障（本地镜像 CI 语义，随 check:clippy 链跑）。
//
// 规则 1：src-tauri 全域禁止裸 `#[allow(clippy::await_holding_invalid_type)]`。
//         clippy.toml（#414）把 tokio 锁卫全家族列为跨 await 非法——有意跨 await
//         的锁卫必须经 pylon-foundations 的 `HeldAcrossAwait` 收口（定义处集中
//         说明纪律：每处使用点保留锁序注释）。
// 规则 2：`HeldAcrossAwait` 使用点与本文件的 INVENTORY 对账——新增/减少使用必须
//         同步登记（条目注明锁名与理由），防止收口类型被静默扩散或拆除。
//
// 用法：node scripts/check-await-holding.mjs（exit 0 = 通过；任何违规 exit 1）。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SCAN_ROOT = join(ROOT, 'src-tauri')

/** 对账清单：路径（正斜杠相对仓库根）→ 文件内 `HeldAcrossAwait` 标识符出现次数
 * （含 use 导入行与定义文件内的文档/泛型引用——防 `use ... as X` 别名绕过）。
 * 每条的理由就在原使用点的锁序注释里（持有的锁名 + 为什么串行化是语义），
 * 这里只登记位置与数量。 */
const INVENTORY = new Map([
  ['src-tauri/pylon-foundations/src/await_guard.rs', 6], // 定义本体（自引用，含文档示例）
  // #548：`pylon-acp/src/client.rs` 的两条 Mutex<Receiver> lane 收口已随 inbox
  // 一次性移交退役，该文件不再持任何跨 await 锁卫——条目移除（原 3 处）。
  ['src-tauri/src/lib.rs', 3], // use + 锁序 switch_lock → agent_lifecycle（后台初始连接双锁）
  ['src-tauri/src/permission.rs', 2], // use + approval_mode_write_lock：内存写→落盘写序
  ['src-tauri/src/dispatcher/crash_reconnect.rs', 2], // use + agent_lifecycle：自动重连入 LifecycleOp 串行
  ['src-tauri/src/gateway/instance.rs', 5], // use + lifecycle_lock：实例 start/restart/stop/remove 整体串行
  ['src-tauri/src/gateway/qq/auth.rs', 3], // use + refresh_lock 单飞（生产 + 单飞语义测试本体）
  ['src-tauri/src/lifecycle/config_cmds.rs', 4], // use + agent_lifecycle（reload）+ config_write_lock ×2（写序事务）
  ['src-tauri/src/lifecycle/mod.rs', 7], // use + switch_lock → agent_lifecycle（switch/reconnect/restart 状态机 ×6 守卫）
  ['src-tauri/src/pet/cmds.rs', 2], // use + pet_write_lock：写盘串行
  ['src-tauri/src/plugin_cmds/transaction.rs', 2], // use + 插件写事务锁：install/uninstall 整体串行
  // #549：`src/session/control.rs` 两处 acp 锁内 cancel 已改快照 + 客户端自带
  // generation 自校验（ADR-0037），该文件仅剩 session_creation 串行（4→2）。
  ['src-tauri/src/session/control.rs', 2], // use + session_creation（close/create 串行）
  ['src-tauri/src/session/create/mod.rs', 3], // use + session_creation：建立序列整体串行 ×2（#486 项3 自 create.rs 拆分随迁）
  ['src-tauri/src/session/persist/load.rs', 2], // use + session_creation：load/恢复串行（#486 项3 自 persist.rs 拆分随迁）
  ['src-tauri/src/session/mod.rs', 3], // use + agent_lifecycle：双检查懒连接 ×2
  // #549：cancel 闭包的 acp 锁已改快照自校验，该文件仅剩 prompt_lock +
  // prompt_gate 单飞（4→3）。
  ['src-tauri/src/session/prompt/wait.rs', 3], // use + prompt_lock + prompt_gate 单飞
  ['src-tauri/src/session/session_expiry_platform_tests.rs', 2], // use + 测试本体持 prompt_gate
])

const WRAPPER = 'HeldAcrossAwait'
const RAW_ALLOW = /\ballow\s*\(\s*clippy\s*::\s*await_holding_invalid_type\b/

const rustFiles = []
const walk = dir => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'target' || entry === 'vendor') continue
      walk(full)
    } else if (entry.endsWith('.rs')) {
      rustFiles.push(full)
    }
  }
}
walk(SCAN_ROOT)

const failures = []
const actual = new Map()
for (const file of rustFiles) {
  const rel = relative(ROOT, file).split(sep).join('/')
  const text = readFileSync(file, 'utf8')
  if (RAW_ALLOW.test(text)) {
    failures.push(`规则 1 违规：${rel} 仍有裸 allow(await_holding_invalid_type)（含合并列表/cfg_attr/内属性等变体）——有意跨 await 的锁卫必须经 HeldAcrossAwait 收口（pylon-foundations/src/await_guard.rs）`)
  }
  // 按类型名计数（不限 ::new）：`use HeldAcrossAwait as X` 之类的别名引入也会因
  // use 行上的类型名被计入，无法静默绕过对账。
  const count = (text.match(new RegExp(`\\b${WRAPPER}\\b`, 'g')) ?? []).length
  if (count > 0) actual.set(rel, count)
}

for (const [file, count] of actual) {
  if (!INVENTORY.has(file)) {
    failures.push(`规则 2 违规：${file} 出现 ${count} 处 ${WRAPPER} 但未在对账清单登记——请在 scripts/check-await-holding.mjs 的 INVENTORY 登记并注明锁名/理由`)
  } else if (INVENTORY.get(file) !== count) {
    failures.push(`规则 2 违规：${file} 的 ${WRAPPER} 数量 ${count} 与清单登记 ${INVENTORY.get(file)} 不符——使用点增减必须同步更新清单`)
  }
}
for (const [file] of INVENTORY) {
  if (!actual.has(file)) {
    failures.push(`规则 2 违规：清单登记了 ${file}，但文件中已无 ${WRAPPER}——条目过期请移除`)
  }
}

if (failures.length > 0) {
  console.error(`check-await-holding: ${failures.length} 处违规`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
const total = [...actual.values()].reduce((sum, count) => sum + count, 0)
console.log(`check-await-holding: 通过（${actual.size} 文件 / ${total} 处 HeldAcrossAwait，全部与清单一致；裸 allow 0 处）`)
