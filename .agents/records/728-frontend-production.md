# Dev Record — #728 全前端生产化与迁移遗留清理

## 元信息

- Issue：https://github.com/Teens-in-Times/Pylon-co-works/issues/728
- 分支：feat/chat-modern-ui；基准 github/main 4d64e138
- 日期：2026-11-12—13；署名：Codex
- 用户授权：全面打磨各页面，可调整业务流程与插件前端骨架；保留插件化架构；终端式界面同步能力；FileSheet 去留尚未决定，因此保留。

## 最终行为

| 责任面 | 行为与目的 |
| --- | --- |
| 外壳、导航与基础控件 | 统一标题栏、页签、启动器、菜单、选择器、对话框；键盘导航、焦点环绕与恢复；左右栏按窗口宽度有效折叠，保留用户宽度偏好 |
| ChatView 与输入 | 现代模式使用连续阅读流、角色时间基线、轻量工具执行轨迹和单个编辑器；发送/停止就近；终端保留命令行、等宽紧凑布局和自定义控件色 |
| 消息正确性 | 保留完整消息边界、semanticParts/contentBlocks 与媒体独立消息；代码后续文本不再被前一代码围栏吞并；异步附件/选择器回调绑定原会话 |
| Agent 导入 | 选择启动入口→验证并导入→显式打开对话；手动入口同样先验证；高级字段/报告展开；失败保留草稿，取消和修改隔离迟到结果 |
| 左侧会话与右侧资源 | 工作区/会话分组、新建会话归属、高亮与键盘操作；文件预览、成果版本收集、网页状态和正文快照、会话搜索；FileSheet 保留深度编辑、Git 和冲突处理 |
| 其他页面 | 首页首次引导、Search、History、Runtime、Gateway、Browser、Docs、设置和插件管理统一层级、密度与状态；搜索/历史失败可重试；历史先筛选后分页 |
| 插件骨架 | 每次呈现独占 DOM 根和可撤销事件桥；旧异步卸载不能清空新页面；失败隔离/重试；保活上下文在 Solid owner 下创建；样式继续随所属插件装卸 |
| 构建门禁 | 全部 JSX 统一 Solid；统一 TypeScript 范围；长期架构门禁单独归类；生产隔离检查保留；清理 Solid 迁移专用构建和脆弱源码断言 |
| 原生缺口 | 修复离线文档资源根少 resources 层及虚假就绪；无工作目录正常空态不发文件请求；同页浏览器状态广播不取消在途正文预览 |

分路详情：[聊天](728-chat-workbench.md)、[页面与导入](728-product-pages.md)、[插件与 Docs](728-plugin-surfaces.md)、[侧栏与资源](728-workspace-explorer.md)。公共扩展接口、预设事务、权限模型保持既有契约。

## 历史代码与测试处置

- 删除独立 Solid smoke HTML/Vite 配置、smoke 组件与 2 个测试文件、tsconfig.solid.json、check-solid-smoke-build、check-solid-workbench-boundaries；统一生产/测试编译覆盖范围。
- check-production-excludes-solid-smoke 改为 check-production-isolation，继续禁止 demo seed/mockTauri 进入生产产物。
- 删除按源码拼写判断接线的 check-context-panel-wiring，保留注册表、宿主、隔离边界行为测试及 renderer 禁止依赖 Tauri 的架构规则。
- 退役 radiusContract、workspaceTitlebar.css、InputBar.css、composerVisualContract、ChatView.modern.css、workbenchChromeCss、Sidebar.css/blocks、FileSheet.css、BrowserSheet.css 的 CSS 文本镜像；inputFontContract 保留字段/投影契约，去掉 2 条 CSS 文本断言。渲染级联由真实 WebView2 几何检查承接。
- 样式归属测试验证唯一归属和生命周期不变量，不复制生产资产清单。新增测试覆盖请求过期、异步卸载、消息边界、富内容真实投影、焦点、搜索导航、导入取消、资源失效等实际行为。
- 搜索不再静默吞掉后端失败或写入无人消费的 pendingMessageLocation，改向完整会话搜索传递关键词；同步删除死的分层例外。
- 清理可确认的 React/Solid 迁移注释；修正 CRLF 手册扫描与 Vite 旧入口扫描/验收缓存锁问题。

## 自动验证

| 命令/范围 | 证据 |
| --- | --- |
| bun run check:frontend | 退出 0；701 文件、5517 用例通过，1 文件/1 用例为既有跳过；target/728-verified-frontend.log |
| 最后会话归属修复 | 专项 36 文件/159 用例与 File 入口 14 用例通过；已纳入最终全量前端检查 |
| 最终生产构建与原生编译 | check:frontend 内 build 退出 0；cargo build 退出 0（42.18s，target/728-verified-native.log）；最终源码已嵌入验收程序 |
| bun run check:rust | 最终完整退出 0，11 组共 1747 用例通过、4 ignored；ACP shadow/fmt 通过；target/728-complete-rust.log |
| 最后 Docs Rust 改动 | cargo test -p pylon --lib docs_sheet：12 通过；DocsSheetView 4 个行为用例通过；cargo fmt 通过 |
| bun run check:clippy（Docs 改动后） | 退出 0；全部 crate 基线外新增诊断 0；17 文件/55 处 await 说明一致、裸 allow 0；target/728-complete-clippy.log |
| 生产隔离 | 223 个 JS assets 中未包含 demo seed/mockTauri；架构、CSS 归属/变量/可达性、IPC、分层等门禁通过 |

测试总数随删除旧实现镜像及新增行为测试变化，不以维持旧数量作为正确性依据。所有最终改动均纳入最后完整前端检查；Rust 全量与 Clippy 对应最终 Rust 源码。

## 浏览器验收

Vite 覆盖有数据的聊天、工具/推理/代码、文件树/编辑器、Search、History、Runtime、Gateway、Browser、设置与插件页；标准演示和视觉矩阵使用各自真实 seed。standard reset 参数忽略旧数据的问题已修复。

- 菜单缺字根因是窗口按钮的 32px 规则命中菜单后代；收窄为原生窗口按钮后，菜单文字列由 0px 恢复为 173.36px。
- textarea 聚焦后 radius=0px、shadow=none、outline=none；现代焦点边界由单个 control-center 编辑器提供。
- 750px 视口展开右栏：左栏 0、正文 406、右栏 320px；667px：正文 368、右栏 275px；恢复 1000px 后左右偏好 250/320px 恢复。
- 折叠左栏 43 个控件逐一尝试聚焦，成功 0 个。
- 真实消息快照→workbench 投影→成果栏得到 3 项成果并可查看正文，两种界面均通过。富内容卡现代半径 4px、终端 2px；Markdown 文档显示标题与正文，纯文本保持原文。
- 当前浏览器视口 1280px 的文档 scrollWidth=1280，无横向溢出。临时 viewport override 已恢复。

## 原生验收

使用独立 target/qa-728-final/pylon.exe、独立 agents.yaml/data/resources，未改用户安装实例。脚本 scripts/check-workspace-layout.mjs 通过 CDP 保存实际几何和截图到 target/qa-728/evidence。

- 新导入 Agent：真实 UI 填写本地 fake-agent 启动入口；故意缺少 scenario 时握手失败、草稿保留；补上参数后验证并创建成功，显示显式“打开对话”。
- 打开对话后直接首次发送，收到“导入后首次发送与终端界面通过。”；未手动重连。首轮零 Agent 配置同样已验证首次激活/建会话/回复。
- 浏览器真实 WebView 打开 https://example.com/，标题 Example Domain；从聊天资源栏打开浏览器，返回按钮回到发起的 session-mwdqwb70。
- Docs 的 404、无目录错误和网页预览竞争均由此次实机暴露并修正，最后重建复验结果在下方登记。

## 限制与交付

- .peri/ 保持原状；不部署、不发布版本、不合并 PR。
- #607 的主题/预设/事务路线保留。仅经明确协调调整 5 个出厂中控色默认及 fixture；现代默认工作面忽略旧内联填充，终端/战术/编辑模式仍使用用户配置，不迁移存储值。
- 真实 ACP 验收使用仓库 fake-agent。未把浏览器 demo 或假 ACP 证据写成所有第三方 Agent、网关与插件都已生产联调。
- 自审重点：插件根/bridge 撤销、资源请求失效条件、无目录首次使用、搜索真实消费者、导入失败恢复、双模式样式归属。说明书已同步最终行为。

### 最终原生复验补充

- 最终构建 cargo build 退出 0（54.32s，target/728-delivery-native.log）。
- 无工作目录会话显示“尚未绑定工作目录”，可见 alerts 为空。
- 离线子 WebView 标题为“Pylon 文档”，实际首页显示桌面 Agent 工作台、入门/插件链接和正文，共 10 个链接，不再是 docs asset not found。
- 真实网页正文已从 Example Domain 返回并呈现在聊天右栏；没有局部错误。终端/现代 1200×800 几何探针均通过。
- 多 Agent 冷恢复发现旧全局选择污染会话记忆；现 Browser/File 返回走归属事务，正文/左右栏过滤跨 owner/profile 选择，切换广播保留有效记忆。最终原生复现通过：重启默认 qa-ui → Browser 返回 pylon-fake-agent 的 session-mwdqwb70，目标正文存在、qa-ui 正文不存在，选中会话正确、绑定错误为空。继续发送“冷启动返回验收：在正确会话继续发送。”后回复数量由 1 增至 2；切 terminal-like 后同样无错误。

- 最后交付截图/JSON：delivery-modern-chat、delivery-terminal-chat、delivery-menu-labels、owner-return-after-restart-final（均位于 target/qa-728/evidence，1200×800、5 个工作表面，几何与绑定检查全部通过）。
- 旧跨 Agent 错误记忆被过滤为空态；手动选回正确会话后，新的 Browser 来源记录可在下次重启后精确返回。原生测试使用明确的两个 Agent 和各自会话，未伪造连接状态。

### 最后事件生命周期修正

日志复查发现浏览器面板随 Agent/Sheet 切换反复注册原生事件，触发 Tauri 注册脚本入队与注销之间的竞态：冷启动出现 handlerId 异常，切换出现已注销 callback 的警告。现在 status/page 两个固定事件由窗口级 browserEventFeed 统一订阅，视图只管理自己的本地消费者；零消费者不投递、不保存会话数据，各面板仍维护独立请求代际。单消费者异常被隔离，SDK 异步注销失败明确记录诊断。生产代码没有访问 Tauri 私有监听表或加入时延。

专项 37 用例通过，覆盖未完成注册时退出、共享监听计数、零消费者、再次进入、多消费者独立退订、错误隔离、异步注销失败，以及 Browser 活动态变化不重订。最终 check:frontend 退出 0：699 文件 / 5510 用例通过、1 文件 / 1 用例既有跳过；生产隔离扫描 223 个 JS assets，通过。日志：target/728-event-delivery-frontend.log。

重新编译原生（36.64s，target/728-event-delivery-native.log）后，冷启动、5 次 Agent 切换、现代→终端→现代、Browser 打开真实网页并返回来源会话：browser-status/page 原生注册数始终各 1，handlerId/callback 注销异常为 0。右栏仍收到 Example Domain 状态与正文，绑定错误为空；event-terminal-browser-final 与 event-modern-browser-final 的 1200×800 / 5 表面几何检查通过。

同轮确认冷启动两条恢复诊断来自隐藏 B 页签遗留的恢复任务（目标 runtime 尚不可用），点击 B 激活后诊断虽可自动恢复，仍不应发生。工作台宿主现仅在活动页签、归属匹配且原生 runtime 明确 connected 时驱动远端 ACP；本地 canonical 历史继续独立读取。effect 退出将旧任务与重试资格失效，不通过延时、隐式启动隐藏 Agent 或吞错解决。新增 3 个原生环境集成用例及 143 个相关用例通过，类型、ESLint 与 diff 检查通过。

后续原生性能检查发现 Browser 打开后有 `browser_set_visible({visible:false})` 连续约每 2ms 一条：状态广播更新整份 snapshot，而 effect 直接读取 snapshot().phase，每次对象变化都会重新同步可见性，后端再次广播形成反馈。此次将 phase、活动态、折叠和弹层依赖收窄为值比较，并隔离副作用回调的隐式追踪；bounds 和工具刷新也不再被无关快照触发。该缺陷说明控制台无错误与布局通过不足以证明空闲性能，最终验收增加网络空闲请求计数。

最终全量前端检查退出 0（701 文件 / 5517 用例，既有 1 文件 / 1 用例跳过），生产隔离 223 个 JS assets 通过；原生重建 42.18s 后冷启动、默认 A 经 Browser 返回 B、网页正文预览、现代→终端全部通过。B 正文保持 3 条真实 ACP 回复，归属与可见绑定错误检查正常；前端 warning/error/exception 共 0 条，浏览器两个事件原生监听仍各 1。空闲网络窗口 5019ms，browser_* 请求 0 条、无连接重建，反馈环已消除。

最终证据：target/qa-728/evidence/verified-runtime.json，以及 verified-modern-resources、verified-terminal-resources、verified-menu-labels 三组 PNG/JSON（1200×800、5 表面，均通过）。最终全量日志 target/728-verified-frontend.log、原生编译日志 target/728-verified-native.log；此前的交付截图保留为迭代记录。验收用 Vite 和原生调试实例已关闭。最新 main 仍为 4d64e138，未落后远端。
