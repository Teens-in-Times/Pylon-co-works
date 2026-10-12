# Dev Record — #602 Rust CI 门禁漏报 + 被其掩盖的三条失败

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/602-rust-ci-gate-and-masked-failures.md`
> 规格：`.agents/spec/602-rust-ci-gate-and-masked-failures.md`（一次性，未入库）

## 元信息

- issue：[#602](https://github.com/Teens-in-Times/Pylon-co-works/issues/602)（主线）、[#601](https://github.com/Teens-in-Times/Pylon-co-works/issues/601)、[#603](https://github.com/Teens-in-Times/Pylon-co-works/issues/603)、[#617](https://github.com/Teens-in-Times/Pylon-co-works/issues/617)
- 分支：`kumo/prometheus`
- 提交范围：`9b54ad30`（开工基点，= `github/main` + 1 个已推送的合并提交）→ 本批三提交：`0e786c99`（L.md 开工声明）、`9a3daee6`（实现 + 说明书）、本记录提交
- 日期：2026-10-12

## 目标与范围

用户原话：

> 不做330，先修好602

> （1）一起 （2）b

即：修好 CI Rust job 的退出码漏报（#602），并一并修复该机制正在掩盖的三条真实失败（#601 / #603 / #617），使门禁由「假绿」变为「真绿」；#617 走用户裁定的 **(b) 重设计控制组**。

**不做什么**：#330；不改 `HideConsoleWindow` 的生产收口面；不重构 `list_workspace_files` 遍历结构、不引入 containment 校验；不改 CI 其余 job；不为 #617 加「环境不满足就跳过」的降级路径。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | `rust-test` job 的「Rust 测试与构建」step：补 `shell: bash` + `set -euo pipefail` 与说明注释 | 修改 |
| `src-tauri/pylon-foundations/src/child_command.rs` | 测试模块：新增 `CREATE_NEW_CONSOLE` 与 `ProbeConsole` 枚举，控制组改用显式新建控制台 | 修改 |
| `src-tauri/pylon-foundations/src/workspace.rs` | `list_workspace_files` 遍历内的 symlink 判定分支；新增差分用例 | 修改 |
| `src-tauri/src/runtime.rs` | `AgentRuntime::install_acp` 的 cfg 门控 | 修改 |
| `src-tauri/src/test_utils.rs` | 模块头过期注释订正 | 修改 |
| `src-tauri/tests/model_switch/mod.rs` | 删除死导入 `std::time::Duration` | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | CI 演进段补 `#602` 一条 | 修改 |
| `.agents/L.md` | 开工声明（单独提交） | 修改 |

## 方案要点

1. **#602 根因是 shell 未声明，不是 cargo 用法**。`rust-test` 的多命令 step 没有 `shell:`，windows runner 落默认 pwsh；GitHub 对 pwsh 的执行形态决定 step 退出码取自最后一条命令的 `$LASTEXITCODE`，故末条 `cargo build` 成功即吞掉前三条。同文件另有 10 处 `shell: bash` + `set -euo pipefail`，本处属漏写。修法与既有写法完全一致，不做结构性改造。

2. **先确定爆炸半径再动手**。拉取 main 最新一次「成功」CI（run `38214851480`，head `29cac928`）的 `Rust(fmt+测试+构建)` job 原始日志，确认被吞的是 **3 条**而非 issue 里写的 2 条：`child_command::tests::hiding_the_console_window_removes_the_window_handle`（当时无人登记，遂新开 #617）、`list_files_does_not_follow_symlink_directories`（#603）、`install_acp` E0599（#601）。这一步也是判定「#602 不能单独合入」的依据——门禁一修好 main 即转红。

3. **#601 是两处门控不一致**，不是可见性问题。`lib.rs` 的 `test_harness`/`test_utils` 门控为 `any(test, feature = "test-agent")`，`install_acp` 只有 `cfg(test)`。集成测试编译 lib 时前者成立、后者不成立 → E0599。对齐后默认生产构建（无 feature）仍不暴露该入口。

4. **#603 是代码与自己文档不一致**，不是语义争议。`list_workspace_files` 的文档注释已写明「只列文件（**含 symlink 文件**，不落内容读取）；目录不进索引……symlink 目录一律不下钻」，但实现用 `file_type().is_dir()` 判目录，而该调用不跟随 symlink——目录 symlink 的 `is_dir()` 为 false，遂落到收录分支。修法是单独判定 `is_symlink()`：目录 symlink 不进也不下钻（`item.path().is_dir()` 跟随链接，因此指向 root 外的目录 symlink 同样被挡），文件 symlink 维持既有契约。**刻意没有选「一律跳过 symlink」**——那会违反上述文档契约，故同时补了一条差分用例把两侧都钉住。

5. **#617 的控制组语义换成了不依赖父进程形态的形态**。原控制组是「不加任何标志位」，只在父进程自己有控制台时成立。spike 实测（无控制台父进程，父自身 `GetConsoleWindow() = 0`）：`CREATE_NEW_CONSOLE` → `528620`、`CREATE_NO_WINDOW` → `0`、**无标志位 → `0`**（即原控制组失效的实证）。控制组改用 `CREATE_NEW_CONSOLE` 后，其成立与父进程形态解耦。

6. **`CREATE_NEW_CONSOLE` 落在测试模块内而非模块级**：首次放在模块级后 `cargo build -p pylon-foundations` 报出 `dead_code`——它只在 `cfg(test)` 下被使用。clippy 门禁判「相对基线零新增」，这条会直接撞门禁，故移进 `mod tests` 并注明原因。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `ci.yml` 该 step 含 `shell: bash` + `set -euo pipefail`；全仓 workflow 无 shell 声明的多命令 `run` 为 0 | 通过（脚本扫描 `ci.yml`/`release.yml`/`docs.yml`/`cargo-mutants.yml`，问题处唯一，已修） |
| 反向验证：失败命令能阻断 step | 通过——**完全忠实复现**：同一命令序列（首条成功、中段 `cargo build -p zzz-nonexistent-crate` 失败、末条成功）在 pwsh 形态下**退出码 0**（复现漏报），在修复形态（`set -euo pipefail`）下**退出码 101** 且第三段未执行 |
| `cargo test -p pylon-foundations --lib` | 通过：`101 passed; 0 failed`（exit 0）。修复前本机同环境为 `2 passed; 1 failed`（child_command 用例） |
| `child_command::tests::hiding_the_console_window_removes_the_window_handle` 在无控制台环境通过 | 通过——**前后对照**：修复前本机同环境 FAILED（`left: 0 / right: 0`），修复后 ok |
| `cargo test --workspace --tests --features test-agent` 编译并运行（#601 判据） | 通过：集成测试 target 编译成功（此前 E0599）；`cargo test -p pylon --test integration --features test-agent` → `28 passed; 0 failed`（exit 0） |
| `cargo test --workspace --lib --features test-agent` | 全绿，**例外 1 条**：`pylon-core` 的 `managed_probe_cleanup_kills_descendant_processes` 在本机失败，已用回退实验证明与本改动无关（见「未解问题」） |
| `cargo fmt --all --check` | 通过（exit 0） |
| `bun run check:clippy` | 通过（exit 0）：7 个 crate 均 `"added": []`，无基线外新增诊断；`check-await-holding` 通过（17 文件 / 55 处） |
| `bun run check:docs` | 通过（exit 0） |
| `list_files_does_not_follow_symlink_directories` 与新增差分用例在 CI 通过 | **未取得本地证据**，判据落在 CI（见「未解问题」第 1 条） |

## 测试处置

- 新增：`pylon-foundations/src/workspace.rs` 的 `list_files_indexes_symlink_files_but_not_symlink_directories`——差分钉住「文件 symlink 进索引 / 目录 symlink 不进索引」两侧。理由：只钉目录一侧时，「一律跳过 symlink」这种过度修正也会通过。
- 修改：`pylon-foundations/src/child_command.rs` 的 `hiding_the_console_window_removes_the_window_handle`——控制组由「不加标志位」改为 `CREATE_NEW_CONSOLE`。**本批唯一改动既有断言语义的测试**，且是 #617 明文要求的修复本体；其辅助函数入参由 `bool` 改为 `ProbeConsole` 枚举以表达「控制组 / 实验组」。
- 保留：`list_files_does_not_follow_symlink_directories` 原样保留（#603 的原始验收面，也是被掩盖的那条）。
- 删除：无。
- 顺带清理（非本批引入，见「与 spec 的偏差」）：`src-tauri/tests/model_switch/mod.rs` 的死导入 `std::time::Duration`；`src-tauri/src/test_utils.rs` 模块头的过期门控描述。

## 证据

- commit：`0e786c99`（L.md 声明）、`9a3daee6`（实现 + 说明书）、本记录提交
- 被掩盖失败的原始证据：run [38214851480](https://github.com/Teens-in-Times/Pylon-co-works/actions/runs/38214851480) / job 114697144833，`06:58:41`–`06:59:08` 区间；`test result: FAILED. 98 passed; 2 failed` + `error[E0599]`，job conclusion 仍为 success
- #617 spike（无控制台父进程）：`self GetConsoleWindow = 0`；`control(CREATE_NEW_CONSOLE) = 528620`、`hidden(CREATE_NO_WINDOW) = 0`、`plain(无标志位) = 0`
- #602 反向验证：pwsh 形态退出码 `0`；bash + `set -euo pipefail` 形态退出码 `101`，第三段未执行
- 本机无控制台环境复现手段：以 Node `windowsHide: true`（libuv 映射 `CREATE_NO_WINDOW`）启动测试二进制
- 测试：`cargo test -p pylon-foundations --lib` → `101 passed; 0 failed`（exit 0）；`cargo test -p pylon --test integration --features test-agent` → `28 passed; 0 failed`（exit 0）；`bun run check:clippy` → exit 0；`bun run check:docs` → exit 0

## 与 spec 的偏差

1. **spec 未预见的两处顺带清理**：`model_switch/mod.rs` 的死导入是 #601 修复让集成测试 target **首次编译通过**后才浮现的（此前 E0599 在更早处中断），在改动半径内故一并清理；`test_utils.rs` 的模块头注释本就已过期（写「仅 cfg(test) 编译」，实际早已是 feature 门控），按 dev-standards §注释规范顺手订正。
2. **spec 预计「如原用例无法表达新控制组有效则补用例」，实际不需要**：原用例的 `assert_ne!(inherited, 0)` 本身就是控制组有效性断言，改造控制组构造方式即已覆盖，故未新增用例。
3. **`CREATE_NEW_CONSOLE` 的位置与 spec 不同**：spec 写的是模块级，实作落在 `mod tests` 内——模块级会触发 `dead_code` 并撞 clippy 门禁（见「方案要点」6）。

## 未解问题

1. **#603 的本地验证缺口（已知且无法在本次消除）**：本机未开启 Windows 开发者模式，`symlink_dir`/`symlink_file` 返回 `EPERM`，两条 symlink 用例都走「创建失败即跳过」分支（本机 0.01s 内 ok 但**未执行任何断言**）。已尝试用 junction 替代失败——junction 的 `is_symlink()` 为 false，命中 `is_dir()` 分支，无法替代。故 #603 的正确性判据**只能落在 CI**（GitHub runner 有 symlink 权限）。合入后须核对 CI 上这两条用例的实测结果，不能以本机的「ok」当作已验证。
2. **#617 的 `CREATE_NEW_CONSOLE` 在 GitHub runner 上的稳定性尚未观测**：spike 与前后对照均在本机（有桌面会话、无控制台进程）取得；runner 的会话形态未在本机复现。若 CI 上控制组仍为 0，需回到 (a) 或改探针语义——届时按新证据重议，本次未预置降级路径。
3. **`pylon-core::agent_detection::tests::managed_probe_cleanup_kills_descendant_processes` 在本机稳定失败（3/3），与本次改动无关**：已做回退实验——仅把 `pylon-foundations` 的两个改动文件 `git stash` 回 HEAD 后重跑，该用例**依旧失败**（`descendant pid file not ready`）。该用例经 `hide_console_window()` 起 `powershell.exe` 再 `Start-Process ping.exe` 并等 pid 文件；而等价的手写 PowerShell 脚本在本机**可以**写出 pid 文件，说明失败与「无控制台宿主」下的某种 spawn/stdio 组合有关，属既有环境性失败（该用例在 main 的 CI 上是 139 passed 之一）。**未登记 issue**（属本机宿主环境现象，非 CI 可见的产品缺陷）；若其他 agent 在执行器下复现，可据此记录开条。

## 并行交集

本批碰过的共享文件，供其他贡献者避让：

- `.github/workflows/ci.yml`（`rust-test` job 段；`changes`/`ci-gate`/其余 job 未动）
- `src-tauri/pylon-foundations/src/child_command.rs`、`src-tauri/pylon-foundations/src/workspace.rs`
- `src-tauri/src/runtime.rs`、`src-tauri/src/test_utils.rs`、`src-tauri/tests/model_switch/mod.rs`
- `docs/说明书/Pylon-模块维护地图.md`（仅文件末 CI 演进段追加）
- `.agents/L.md`（已按「只留在途」约定在合入后撤下本条目）
