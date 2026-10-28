# Dev Record — #670 插件包 list/inspect 去重哈希与线程边界

> 入库保留。产出路径：`.agents/records/issue-670-plugin-list-hash.md`

## 元信息

- issue：[#670 plugin_package_list 每次刷新重读并哈希全部已安装包；inspect 系列在 reactor 线程做全量哈希](https://github.com/Teens-in-Times/Pylon-co-works/issues/670)
- 分支：`perf/plugin-list-hash`
- 日期：2026-10-29
- 施工署名：Qoder

## 根因

`describe_installed` 走 `describe_source`：遍历目录并对每个文件 `File::open` + 64KB 读 +
FNV 哈希，产出 `{id}@{version}-{fingerprint}` 形式的 `package_instance_id`，随后立刻用
目录名覆盖该字段。`plugin_package_list` / `plugin_package_versions` 每次调用都按包体量
重复一遍读盘；且这些 async command 直接在 reactor 线程做同步 IO。`inspect` 三个命令
同样在 reactor 线程对源目录/解压目录做整包哈希。

## 修复

- `store`：抽出 `walk_files`（校验 + 清单），`scan` 保留内容哈希（源/staging 校验），
  新增 `scan_metadata`（只读元数据）。
- `transaction::describe_installed`：`manifest_details + scan_metadata`，身份直接取目录名。
- 新增 `run_plugin_read` 骨架：`plugin_package_list` / `plugin_package_versions` 的盘 IO
  移入 `spawn_blocking`；`plugin_package_inspect`、`plugin_package_inspect_zip/url` 的
  `describe_source` 同样移出 reactor。

## 验证

- `cargo test -p pylon plugin_cmds` → 22 passed（新增
  `installed_descriptor_uses_directory_identity_and_metadata_scan`：list 描述与
  `describe_source(已安装目录)` 的清单/体积/manifest 对拍）
- `cargo fmt --all --manifest-path src-tauri/Cargo.toml --check` → 通过
- `bun run check:clippy` → 通过（await-holding 基线不变）
- 读数：合成 40MB 包 hash-scan 11.8 ms → metadata-only 1.22 ms（warm cache）

## 边界

未改 manifest 校验、安装事务的源指纹比对、state.json 语义与前端 wire 形状。
