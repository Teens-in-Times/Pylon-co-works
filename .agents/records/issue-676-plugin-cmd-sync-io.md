# Dev Record — #676 插件命令残余同步阻塞 IO

> 入库保留。产出路径：`.agents/records/issue-676-plugin-cmd-sync-io.md`

## 元信息

- issue：[#676 fix(plugin): 插件命令残余同步阻塞 IO——文本资源读取（≤8MB）与 runtime 目录创建/递归删除都在 reactor 线程](https://github.com/Teens-in-Times/Pylon-co-works/issues/676)
- 分支：`fix/plugin-cmd-blocking-io`
- 日期：2026-10-29
- 施工署名：Qoder

## 背景

#657 已把插件安装链路的下载/解压/导出/reg.exe 移出 async 上下文；同族命令里还有三处
同步 IO 直接跑在 Tauri 命令的 reactor 线程：

- `plugin_package_read_text`：`resolve_resource`（含 `canonicalize`）+ `metadata` +
  `read_to_string`，上限 8MB；
- `plugin_runtime_create`：`ensure_layout_at`（多级 mkdir）+ `fs::create_dir`；
- `plugin_runtime_cleanup`：`fs::remove_dir_all`（递归）。

插件首次加载会连续读多个资源、挂载/卸载时建删目录，单次即可占住 reactor 数毫秒以上，
与 #261/#657/#670 的「命令层不做同步 IO」标准不一致。

## 修改

- `src/plugin_cmds/resource.rs`：读路径抽成 `read_text_at(root, id, path) -> Result<String, PluginError>`，
  命令体只保留 `root(&app)` 与 `spawn_blocking`。
- `src/plugin_cmds/runtime_cmds.rs`：create 的 `ensure_layout_at + create_runtime_at`、
  cleanup 的 `cleanup_runtime_at` 各自整体进 `spawn_blocking`。
- 字符串校验（`split_package_id` / `validate_relative_path` / `validate_runtime_id`）留在
  同步段——不碰盘，无效输入不进 blocking 池。

## 语义

错误分支不变（`NotFound` / `ResourceInvalid` / `not UTF-8` / `Io` 原样冒泡）；只有
`JoinError`（panic 或运行时关停）新增一层 `plugin read task failed` /
`plugin runtime task failed` 的 `PluginError::Io` 包装，与 #670 的 `plugin inspect task failed` 同款。

## 验证

- `cargo test -p pylon --lib plugin_cmds`：21 passed
- `cargo test -p pylon --lib`：985 passed / 4 ignored
- `cargo fmt --check`、`bun run check:clippy`（await-holding 17/55 不变）

## 说明

未新增基准：本类改动的收益是「reactor 不被占住」，单点耗时取决于磁盘与目录深度，
不构造合成数据声称数字。`plugin_resource_response`（协议线程）与 `reload_agents`
的 KB 级配置读不在本次范围。
