# Dev Record — #657 残余同步阻塞 IO 移出 async 上下文

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-657-residual-sync-io.md`

## 元信息

- issue：[#657 refactor(async): 残余同步阻塞 IO 仍在 async 上下文（插件安装解压 / 会话导出 / Agent 检测 reg.exe）](https://github.com/Teens-in-Times/Pylon-co-works/issues/657)
- 分支：`fix/residual-sync-io`（基于 `github/main` = `e1eced0c`）
- 提交范围：`e1d236b0`（L.md 单行登记）→ 本提交（三处源文件 + `plugin_cmds/tests.rs` + 本 record）
- 日期：2026-10-28
- 施工署名：Qoder（L.md 已登记）
- 同批：后端体检登记 #653/#654/#655/#656，本条为最后一项

## 问题

三处同步阻塞调用直接写在 `async fn` 里——错误不在于「用了同步 API」，而在于**执行线程
与所有权错配**：tokio worker 被文件写入 / `fsync` / 子进程等待占住，同一 runtime 上的
其它任务（命令处理、超时计时、事件投递）排队，表现为「卡一下」，并把真实故障掩盖成延迟。

| 位置 | 同步调用 | 量级 |
| --- | --- | --- |
| `plugin_cmds/install_remote.rs` 下载循环 | `std::fs::File::create` / `write_all` / `sync_all` | 最长 120s 下载窗口内持续落盘 + 一次 fsync |
| 同文件解压（4 个调用点） | `extract_zip_archive`（纯同步） | zip ≤ 64 MiB，解压总量另有上限 |
| `export.rs::export_session` | `write_export_atomically`：`create_new` + `write_all` + `sync_all` | 大会话导出，一次几百毫秒 fsync |
| `agent_detection/scan/tools.rs` | `persisted_path_gap()` → 两次 `reg.exe query`（`std::process::Command::output`） | 每次扫描固定两次子进程等待 |

## 实现

### 1. 下载：`tokio::fs`（不改进度粒度）

```rust
let mut file = tokio::fs::File::create(dest).await.map_err(PluginError::Io)?;
...
file.write_all(&chunk).await.map_err(PluginError::Io)?;
...
file.sync_all().await.map_err(PluginError::Io)?;
```

issue 的「目标结构」建议把下载循环整体搬进 blocking 任务、进度经通道回传。这里改走
`tokio::fs`，理由：

- 进度事件 `downloading` 的**粒度与顺序完全不变**（issue 风险项里「事件可能合并/滞后
  一个块」直接消失），前端 `install-progress` 时序零变化；
- 大小上限、限流、取消与错误类型都留在 async 侧，校验逻辑一行未动；
- `tokio::fs` 内部就是丢进 blocking 池，worker 同样不被占住，但少一层通道与线程生命周期。

### 2. 解压：统一 `extract_zip_off_thread`

```rust
pub(crate) async fn extract_zip_off_thread(
    zip_path: PathBuf,
    dest: &Path,
) -> Result<(), PluginError> {
    let dest = dest.to_path_buf();
    tokio::task::spawn_blocking(move || {
        extract_zip_archive(&zip_path, &dest, MAX_INSTALL_ZIP_BYTES, MAX_INSTALL_EXTRACT_BYTES)
    })
    .await
    .map_err(|error| PluginError::Io(format!("zip extraction task failed: {error}")))?
    .map(|_extracted_files| ())
}
```

- 调用点四处：`install_from_zip_source` 的 LocalZip / Url、`plugin_package_inspect_zip`、
  `plugin_package_inspect_url`——后两处是同一病灶（解压直接写在 async 命令里），一并收敛；
- `extract_zip_archive` 本体与 `pub(crate)` 可见性不动（zip-slip / symlink / 大小上限
  的既有测试直接调它）；`JoinError` 包装成 `PluginError::Io`，领域错误原样透传。

### 3. 导出：原子写整体下沉 + guard 收块

```rust
{
    let sessions = runtime.sessions.lock().map_err(|error| error.to_string())?;
    if sessions.get(&source).map(|session| { ... }) != Some(true) {
        return Err(PylonError::Protocol("export session became stale".to_string()));
    }
}
...
let output = output.to_path_buf();
let bytes = content.into_bytes();
tokio::task::spawn_blocking(move || write_export_atomically(&output, &bytes))
    .await
    .map_err(|error| format!("export write task failed: {error}"))??;
```

`MutexGuard` 不实现 `Send`，新增 await 后原写法（`let sessions = ...; drop(sessions)`）
无法通过 coroutine 的 Send 证明，编译报
`future cannot be sent between threads safely`（`src/export.rs:133`）。把校验收进独立
块，guard 在块尾析构，问题从结构上消失——这本身也是「锁不该跨 await」的显式表达。
`write_export_atomically` 的 `create_new` / 半成品删除语义一字未改。

### 4. Agent 检测：`persisted_path_gap` 进阻塞池

```rust
let path_gap =
    match tokio::task::spawn_blocking(crate::agent_diagnostics::persisted_path_gap).await {
        Ok(report) => report,
        Err(error) => {
            tracing::warn!("persisted PATH probe task failed: {error}");
            crate::agent_diagnostics::PathGapReport::default()
        }
    };
```

`JoinError` 回落 `PathGapReport::default()`（`observed = false` = **未观测**），与既有
「读不到就不报 gap」一致——不会把「探测失败」伪装成「没有 gap」。该扫描链路本就使用
`tokio::process`，必然有 runtime，`spawn_blocking` 不会 panic。

## 验收

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 插件安装/解压 | `cargo test -p pylon --lib plugin_cmds::` | 21 passed（含新增 1） |
| 导出 | `cargo test -p pylon --lib export::` | 10 passed |
| Agent 检测 | `cargo test -p pylon-core --lib agent_detection` | 39 passed |
| 类型检查 | `cargo check -p pylon --tests` / `-p pylon-core --tests` | 通过 |
| 格式 | `cargo fmt --all --manifest-path src-tauri/Cargo.toml --check` | 通过 |
| clippy | `bun run check:clippy` | EXIT=0，基线零新增 |
| 持锁跨 await | 同上内置 `check-await-holding` | 17 文件 / 55 处，与清单一致；未新增豁免 |

新增测试 `plugin_cmds::tests::extract_zip_off_thread_surfaces_extraction_errors`：
合法 zip 经阻塞边界解压成功；缺 `pylon-plugin.json` 的 zip 仍返回
`PluginError::SourceInvalid`（而非被包装成 task 失败），确认阻塞边界不吞错误类型。

一次全量 `agent_detection` 运行里 `managed_probe_cleanup_kills_descendant_processes`
报 `descendant pid file not ready`；单测重跑与整组重跑均通过（39 passed），属该测试
既有的就绪等待在高并发负载下的抖动，与本次改动无关（本改动不触碰 probe 清理路径）。

## 判断边界（明确不做）

- `install_at` / `ensure_layout_at` / `describe_source` / `cleanup_install_temp` 仍在
  async 命令里同步执行：它们是**安装事务本体**，搬进 blocking 会改变事务边界与回滚
  时序，超出本 issue 枚举范围；若要处理应单独登记。
- `check_export_parent` / `output.is_dir()` 等单次 `stat`：纳秒级，不构成 worker 占用。
- 未动 #655（stdin 背压）/ #656（写锁内 kill）的线；未改 `AcpClient::kill` 语义。

## 风险与回滚

三处改动互相独立（下载 / 解压 / 导出 / 检测），任一处异常可单独回退该文件的改动。
行为面风险集中在「错误包装」：`JoinError` 只可能来自 panic 或 runtime 关闭，前者在
`panic = "abort"` 下本就是进程终止，后者等价于进程退出前的收尾——两者都不引入新的
用户可见语义。
