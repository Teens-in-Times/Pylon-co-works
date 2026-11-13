# Dev Record — #730 0.5.0-FUR 发行与生产升级

- 署名：Codex
- 日期：2026-11-13
- 分支：feat/chat-modern-ui；基准 15e93a45（已合并 #729）
- 用户授权：构建 release、打包上传 GitHub、替换本机生产实例；明确选择版本 0.5.0-FUR。

## 版本与构建

使用 release skill 及 scripts/pack_release.py --bump 0.5.0-FUR --build，版本落位提交 8a4eb29a。未手改版本文件，未更改本轮已验收的前端行为。G 盘余量接近门槛，本轮 CARGO_TARGET_DIR 为 D:/DevCache/pylon-release-target。

## 验证

- #729 合并前 GitHub 8 项检查均 SUCCESS；其最终本地证据见 728-frontend-production.md。
- 本轮 bun run test:pack：45 项通过，退出 0，target/730-pack-tests.log。
- 本轮 bun run check:clippy：退出 0，基线外新增诊断 0；17 文件 / 55 处 await 清单一致、裸 allow 0，target/730-clippy.log。
- release 全链退出 0（target/730-release-build.log），本地 ZIP 39,191,005 bytes；296 项 manifest 与 ZIP 一致、内容审计通过。SDK、离线文档、检测工具和 MCP 工具均由正式全链生成。正式资产和生产部署最终证据回写 [#730](https://github.com/Teens-in-Times/Pylon-co-works/issues/730)，版本 PR 不自动关闭该 issue。

## 生产定位与回滚

生产路径 F:/A-I/Platform/Pylon，入口 pylon.exe；原程序 ProductVersion=0.4.4-KXP，大小及 SHA256 与正式发行 manifest 一致。主程序检查时未运行；两个 MCP helper 使用安装目录内工具，替换时需兼容在用文件。

完整备份位于 D:/Project/Pylon-backups/before-0.5.0-FUR-20261113/Pylon。复制后逐文件 SHA256 核对：1003 文件、0 不匹配。保留整个 data 及 agents.yaml、agents.yaml.bak；备份未进入发布包或版本库。部署仅替换发行清单拥有的文件，配置、会话数据库及 WAL/SHM、插件和凭据保留。出现升级失败时从完整备份恢复。

## 测试处置与边界

没有增加、删除或放宽测试。公开发行走 main 归属守卫和 tag CI；本地包是预演，生产优先使用正式上传资产。无其他在途代码改动，.peri/ 保持原状。开发规格目标已在此承接。
