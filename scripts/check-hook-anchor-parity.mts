#!/usr/bin/env bun
/**
 * check-hook-anchor-parity —— 插件 hook 锚点集一致性门禁（#37 核验建议，ADR-0001）。
 *
 * 单一事实源 = `src/plugin-runtime/hooks/hookTypes.ts` 的 `HOOK_NAMES`。规则：
 *   1. 开发者手册 §6.2 的 ```text 词表块必须与 TS 词表**全等**（逐项全名，禁用简写）；
 *   2. Rust 锚点常量（src-tauri/src/hook_bridge.rs 的 `const HOOK_*: &str`）必须是
 *      TS 词表的**子集**——Rust 派发面只派发前端词表内的锚点（#37：派发词表外锚点
 *      会使插件声明与执行两端同时静默失效）；其余锚点由前端域派发，Rust 无需声明。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message: string): never {
  console.error(`check-hook-anchor-parity: ${message}`)
  process.exit(1)
}

function extractTsAnchors(): string[] {
  const source = readFileSync(join(root, 'src/plugin-runtime/hooks/hookTypes.ts'), 'utf8')
  const match = source.match(/export const HOOK_NAMES = \[([\s\S]*?)\] as const/)
  if (!match) fail('hookTypes.ts 缺少 `export const HOOK_NAMES = [...] as const` 词表块')
  const anchors = [...match![1]!.matchAll(/'([a-z][a-zA-Z0-9.]*)'/g)].map(entry => entry[1]!)
  if (anchors.length === 0) fail('hookTypes.ts HOOK_NAMES 词表为空或解析失败')
  return anchors
}

function extractRustAnchors(): string[] {
  const source = readFileSync(join(root, 'src-tauri/src/hook_bridge.rs'), 'utf8')
  const anchors = [...source.matchAll(/const\s+HOOK_[A-Z0-9_]+:\s*&str\s*=\s*"([^"]+)"/g)].map(entry => entry[1]!)
  if (anchors.length === 0) fail('hook_bridge.rs 未找到任何 `const HOOK_*: &str` 锚点常量')
  return anchors
}

function extractManualAnchors(): string[] {
  const source = readFileSync(
    join(root, 'docs/说明书/Pylon-插件系统说明书-开发者版.md'),
    'utf8',
  )
  const section = source.match(/### 6\.2 Hooks[\s\S]*?```text\r?\n([\s\S]*?)```/)
  if (!section) fail('开发者手册缺少「### 6.2 Hooks」下的 ```text 词表块')
  const anchors = section![1]!
    .split('\n')
    .map(line => line.trim().replace(/\s*#.*$/, ''))
    .filter(line => line.length > 0)
  if (anchors.length === 0) fail('开发者手册 §6.2 词表块为空')
  return anchors
}

function duplicatesOf(anchors: string[]): string[] {
  const seen = new Set<string>()
  const duplicated: string[] = []
  for (const anchor of anchors) {
    if (seen.has(anchor)) duplicated.push(anchor)
    seen.add(anchor)
  }
  return duplicated
}

function diffSet(name: string, anchors: string[], baseline: Set<string>): string[] {
  const missing = [...baseline].filter(anchor => !anchors.includes(anchor))
  const extra = anchors.filter(anchor => !baseline.has(anchor))
  for (const anchor of missing) {
    console.error(`  ${name} 缺少锚点: ${anchor}`)
  }
  for (const anchor of extra) {
    console.error(`  ${name} 含未知锚点: ${anchor}`)
  }
  return [...missing, ...extra]
}

const tsAnchors = extractTsAnchors()
const rustAnchors = extractRustAnchors()
const manualAnchors = extractManualAnchors()

let broken = false
for (const [name, anchors] of [
  ['hookTypes.ts', tsAnchors],
  ['hook_bridge.rs', rustAnchors],
  ['手册 §6.2', manualAnchors],
] as const) {
  const duplicated = duplicatesOf(anchors)
  if (duplicated.length > 0) {
    console.error(`  ${name} 重复锚点: ${duplicated.join(', ')}`)
    broken = true
  }
}

const baseline = new Set(tsAnchors)
broken ||= diffSet('手册 §6.2', manualAnchors, baseline).length > 0
// Rust 派发面 ⊆ TS 词表（方向性检查：Rust 不得发明词表外锚点；反之 TS 新锚点
// 若尚未接任何派发面，属产品完整性问题，不在此拦截）。
broken ||= diffSet('hook_bridge.rs（Rust 派发面）', rustAnchors.filter(anchor => !baseline.has(anchor)), new Set()).length > 0

if (broken) {
  console.error(`check-hook-anchor-parity: 锚点集漂移（TS ${tsAnchors.length} / Rust ${rustAnchors.length} / 手册 ${manualAnchors.length}）`)
  process.exit(1)
}
console.log(`check-hook-anchor-parity: TS 词表 ${tsAnchors.length} 个锚点，手册全等，Rust 派发面 ${rustAnchors.length} 个为其子集`)
