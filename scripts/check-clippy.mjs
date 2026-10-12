#!/usr/bin/env node
// 本地镜像 CI 的 clippy 门禁（.github/workflows/ci.yml 的 rust-clippy job）：
// `cargo clippy --workspace --all-targets` 收诊断 → 逐 crate 与
// `artifacts/clippy-baseline.json` 比「新增诊断数」（历史诊断常驻基线，只判新增）。
//
// 为什么需要它：`cargo test`、`check:rust` 都不跑 clippy，clippy 原先只在 CI 判红——
// 本地把其它门禁跑绿也照样会在 CI 才发现，于是「忘记 clippy」成了常态
// （实测代价见 #382 期间：分支 CI 红在 `clippy::items_after_test_module`，
// 直到 clippy job 跑完才暴露）。本脚本把这条门禁变成本地一条命令。
//
// 用法：`bun run check:clippy`（已并入 `check:all`）；诊断 JSON 落在系统临时目录，
// 不写仓库工作树（CI 落 artifacts/ 是因为要上传失败证据包）。
//
// ⚠️ 下面的 CRATES 列表与 ci.yml 的循环**必须同源**：改一处要同步另一处，
// 否则本地与 CI 的判红面不一致（多了/少了 crate 都等于漏判）。

import { spawnSync } from "node:child_process"
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, URL } from "node:url"
import process from "node:process"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const baseline = "artifacts/clippy-baseline.json"
const CRATES = ["pylon", "pylon-core", "pylon-acp", "pylon-session", "pylon-foundations", "pet-core", "pylon-agent-history"]

const cargo = process.platform === "win32" ? "cargo.exe" : "cargo"
const work = mkdtempSync(join(tmpdir(), "pylon-clippy-"))
const report = join(work, "clippy-workspace.json")

const out = openSync(report, "w")
const clippy = spawnSync(cargo, [
  "clippy",
  "--manifest-path", "src-tauri/Cargo.toml",
  "--workspace",
  "--all-targets",
  "--message-format=json",
], { cwd: root, stdio: ["ignore", out, "inherit"], shell: false })
closeSync(out)

if (clippy.error || clippy.status !== 0) {
  rmSync(work, { recursive: true, force: true })
  const detail = clippy.error ? `（${clippy.error.message}）` : ""
  console.error(`check:clippy FAILED — cargo clippy 未跑通（exit ${clippy.status ?? "?"}）${detail}`)
  process.exit(clippy.status ?? 1)
}

let failed = 0
for (const spec of CRATES) {
  const result = spawnSync(process.execPath, [
    "scripts/check-clippy-baseline.mjs", report, baseline,
    `--crate=${spec}`, "--crate-dir=src-tauri", `--package=${spec}`,
  ], { cwd: root, stdio: "inherit" })
  if (result.status !== 0) failed = 1
}

rmSync(work, { recursive: true, force: true })
if (failed !== 0) {
  console.error("check:clippy FAILED — 有 crate 出现基线外的新诊断；修掉，或先与仓库主确认再更新基线")
}
process.exit(failed)
