# Dev Record — #266 CC-18 全高滚动条独占右列

> 当前有效结果见末尾「03替代单」；下方前件/接续结果为历史，不是整件完工依据。用户初衷是滚动条从标题栏下沿延伸到应用底，中控处于其左侧；前两张单把它误译为仅横向对齐，旧全绿只能证明旧目标。按单执行者不为该需求误译负责。

## 元信息

- issue：#266（CC 总账；本件 = CC-18）
- 分支：`feat/cc-18-cc-margin-rail-zero`（`git fetch` → 基于 `origin/main` `00ed9aa0`）
- 提交范围：CC-18 最终代码、配套测试与本记录；用户已授权提交、推送、草稿PR和CI。各历史阶段的“未提交”描述保留为当时事实。
- 责任署名：ZCode（翻译与独立验收；施工过程见各阶段记录）
- 日期：2026-10-09

## 目标与范围

**要达成**：中控「左右边距」（`ccMarginX`）的**右零点**从「应用右缘」改挂**滚动条（rail）左缘**——右侧始终让出 rail 占的那一条；左边不变；两边同值 ⇒ 中控在「聊天列（排除 rail）」内居中。终端-默认预设该值记 **0**（0 = 中控右缘与 rail 左缘齐平）。

**不做**：那 6 条自带 `15` 的出厂预设（terminal claude/nord/tokyo/amber/matrix + gui solarized）；字段默认值（仍 `15`）；GUI-默认预设；滚动条自身外观（外壁 12/14 是既有定案）；rail 宽度不做成设置项；不加任何 clamp / 钳制（读写路径一字未动）；D 档其它件（CC-19~CC-25）；顺手优化与重命名。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/plugins/product/packages/builtin.pylon-renderers/styles/components/solid-workbench/WorkbenchChrome.css` | 「聊天滚动轨道」块：`--scroll-action-rail-width` 的**声明**从 `.solid-workbench-chat-shell` 提到 `:root`（基础 `12px`，`@media (max-width:640px)` 覆写 `14px`）；`.solid-workbench-chat-shell` 只留 `--scroll-action-end-size`；注释补「三处消费方 + 不许再抄一份」 | 修改 |
| `src/plugins/product/packages/builtin.pylon-renderers/styles/components/ControlCenter.css` | `.control-center` 的 `margin-inline` 拆成 `margin-left` / `margin-right`（右 = `calc(var(--cc-margin-x,20px) + var(--scroll-action-rail-width, 0px))`） | 修改 |
| `src/domains/theme/presets/builtin.ts` | `TERMINAL_DEFAULT_THEME` 加 `ccMarginX: 0` + 三处注释（刀7 外观来源列表、值来源块、`TERMINAL_DEFAULT_THEME` 行注） | 修改 |
| `src/__tests__/defaultPresets.solid.test.tsx` | `TERMINAL_CONTRACT` 加 `ccMarginX: 0`；新增 1 条用例 | 修改 |

## 方案要点

- **rail 宽度单一声明**：只在 `:root` 声明。两个消费方不在 `.solid-workbench-chat-shell` 子树里 —— 创建浮层的 `--creation-overlay-right-inset` 与中控右边距；设置页「中控预览」（`.pv-app`）也在 workbench 子树之外，同样要拿到同一个数。提到根上是「一处声明、处处继承」的唯一做法，故别处不再出现 `12` / `14`。
- **右零点由一个 calc 承载**（唯一改动点）：`margin-right: calc(var(--cc-margin-x,20px) + var(--scroll-action-rail-width, 0px))`。兜底 `0px`（而非 `12px`）：拿不到该 token 的环境（jsdom 单测等无全局 CSS）行为与改造前一致。
- **只改终端-默认的取值**：`ccMarginX: 0` 进 `TERMINAL_DEFAULT_THEME`（该表 = glass 副本 + 终端契约字段，本件多一个 `ccMarginX: 0`，是两条默认预设**有意**的取值差）。字段默认值仍 `15`、出厂 6 处仍 `15` ⇒ GUI 模式重置后仍是 15（用户 2026-10-09 原话：「那几个都不管」）。
- **空态原覆盖已由接续单撤销**：前件的 `.is-empty { margin: 0; width: 100% }` 曾绕过共享横向边距；“空态无需改动”的前件判断已被用户 2026-10-09 定案及接续单替代，不再作为交付结论。当前空态仅 `margin-block: 0`、`width: auto`，与有会话继承同一共享算式，详细证据见接续结果。

## 前件验收标准与当时结果（历史证据，不代表接续单通过）

| 验收项（施工单 §5） | 结果 |
| --- | --- |
| 1 门禁五步全绿 | ✅ lint / build:example-plugin / build / check:solid / test 全 EXIT=0（读见「证据」） |
| 2 数据读数 | ✅ `DEFAULT_PRESETS.terminal.theme.ccMarginX === 0`；`DEFAULT_PRESETS.gui.theme.ccMarginX === undefined`；带该字段的出厂条目恰好 6 条且全 `15`（新用例逐条点名） |
| 3 实机·终端模式（有会话）重置 | ✅ `--cc-margin-x` computed = `0px`；中控 right **1188** == rail left **1188**（差 0px）；rail 宽 12px（窗口 1200） |
| 4 实机·空态 | ⚠️ **口径与代码现实冲突**：实测「中控 right − section right」= **0px**（不是 −12px），来源是既有的 `.is-empty{margin:0}`；改前改后一致 ⇒ 无跳变（详见「与 spec 的偏差」） |
| 5 实机·窄窗 ≤640px | ✅ 视口覆写 600px：rail 宽 **14px**、中控 margin-right `14px`、中控 right **596** == rail left **596**（相对 section 内缩由 12 → 14，自动跟随） |
| 6 实机·GUI 模式重置 | ✅ `--cc-margin-x` = `15px`；中控 right **1157** = rail left **1172** − 15 |
| 7 实机·切预设 | ✅ 出厂 10 套全 `15px`（GUI 桶 glass/solarized/agent-command/agent-map/focus-flow 与终端桶 claude/nord/tokyo/amber/matrix 各 5） |
| 8 契约快照重拍 | ✅ `bun scripts/check-workbench-theme-contract.mts --write` 后 `git diff` 该 JSON **内容 0 处变化**，仅 `generatedAt` 时间戳变动（已 `git checkout` 还原该文件，故工作树无该文件改动） |
| 9 说明书同步 | ✅ `docs/` 检索「ccMarginX / 边距零点 / 滚动条 / scroll-rail / scroll-action-rail」命中 **0** ⇒ 无需改动 |
| 10 回单四块 + 几何数值 | ✅ 见汇报文件（`file:line` + `getBoundingClientRect` 数值） |

## 测试处置

- **改（点名）**：`src/__tests__/defaultPresets.solid.test.tsx` 的 `TERMINAL_CONTRACT` 加 `ccMarginX: 0` —— 契约变更：终端默认与 GUI 默认在这一字段上**有意不同**；连带使同文件的「重置后 == GUI 默认 + 终端契约字段」（`toEqual`）、「glass 切面摘掉契约字段再比」的过滤、以及 `toMatchObject` 三条继续成立。
- **新增（1 条）**：`★ #266 CC-18：中控右零点挂滚动条 —— 终端默认落 0，GUI 默认与 6 条出厂条目不动`（住 `刀7 · 「重置主题」落点（#214）`）。三段：终端重置后 `ccMarginX === 0`；GUI-默认不含该键且 GUI 重置后 == `DEFAULTS.ccMarginX`；出厂条目里带该字段的恰好 6 条且全 `15`。
- **删**：无。
- **未触碰**：`ccVisibilitySliceGuard.test.ts` / `firstRunThemeSeed.test.ts` / `effectivePresetTheme.test.ts` / `presetAssembly.test.ts` / `SettingsPreview.migration.solid.test.tsx`（全绿）。

## 证据

- **commit**：无（按铁律未提交）。
- **门禁五步**（仓库根目录执行）：
  - `bun run lint` → `LINT_EXIT=0`
  - `bun run build:example-plugin` → `EXIT=0`（`examples\plugins\example.solid-renderer\dist\entry.js 5.5kb`）
  - `bun run build` → `EXIT=0`（`✓ built in 15.36s`）
  - `bun run check:solid` → `EXIT=0`（含 `CSS 消费审计通过（注入 104 / 消费 336 / 声明 356，死注入与悬空引用均为 0）`、`Workbench 皮肤 contract 通过`）
  - `bun run test` → `Test Files 683 passed | 1 skipped (684)`；`Tests 5319 passed | 1 skipped (5320)`；`EXIT=0`
  - 未动 `src-tauri/` ⇒ 本地免 `check:rust` / `check:clippy`。
- **反向验证（必做组，新测试）**：把 `TERMINAL_DEFAULT_THEME` 的 `ccMarginX` 临时改成 `15` ⇒ 贴红（原样）：
  ```
  FAIL  solid-dom  src/__tests__/defaultPresets.solid.test.tsx > 刀7 · 「重置主题」落点（#214） > ★ #266 CC-18：中控右零点挂滚动条 —— 终端默认落 0，GUI 默认与 6 条出厂条目不动
  AssertionError: expected 15 to be +0 // Object.is equality

  - Expected
  + Received

  - 0
  + 15

   ❯ src/__tests__/defaultPresets.solid.test.tsx:185:54
      185|     expect(DEFAULT_PRESETS.terminal.theme.ccMarginX).toBe(0)
         |                                                      ^
  ```
  同时既有契约用例也红（证明契约变更真被锁住）：`terminal-like 模式：重置后 == GUI 默认 + 终端契约字段` 在 `src/__tests__/defaultPresets.solid.test.tsx:166:29` 报 `- "ccMarginX": 0 / + "ccMarginX": 15`；`两条默认预设的形状…`（`toMatchObject`）同样红。改回后 13/13 绿。
- **反向验证（建议组，实机）**：把 `ControlCenter.css` 的 `margin-right` 临时改回 `var(--cc-margin-x,20px)` → `bun run build` → 重载页面 → 读数：中控 right **1200** vs rail left **1188**（差 **+12px**，关系不成立）⇒ 证明坐标零点确实由这一行承载。改回 + 重建 + 重载后复验：right **1188** == rail left **1188**（差 0px）。
- **实机环境**：本仓运行中的 Pylon（`tauri dev` 形态，前端由 `http://127.0.0.1:1430/` 静态服务送出 `dist/`，调试端口 9222）；窗口 1200×800；会话 `smu81i40f`；终端模式。每次改样式后 `bun run build` 并重载页面，并在 CSSOM 里核对**这一轮改过的选择器**（`:root{--scroll-action-rail-width:12px}`、窄屏 `:root{14px}`、`.control-center` 的 `margin-left`/`margin-right`）在不在，而非只看界面像不像。
- **手工验证（几何，`getBoundingClientRect`，jsdom 无法覆盖的部分）**：
  | 场景 | section | 中控 | rail | 关系 |
  | --- | --- | --- | --- | --- |
  | 终端默认（`--cc-margin-x: 0px`） | 250→1200 | 250→**1188** | **1188**→1200（12） | 中控 right == rail left（差 0） |
  | GUI 模式重置（`15px`） | 266→1184 | 281→**1157** | **1172**→1184（12） | 中控 right == rail left − 15 |
  | 窄屏（视口 600px） | 250→610 | 250→**596** | **596**→610（**14**） | 中控 right == rail left（差 0） |

## 前件偏差与接续裁决

- **前件空态失败证据保留**：前件实测空态外框 right − section right = 0，而非 −12；既有 margin:0/width:100% 覆盖了共享边距。原记录据此说“无需做、不会跳”的判断不成立，已由接续单统一原点要求替代。
- **设置预览措辞更正**：宽窗 M=15 时右距从15变27。相对容器左边不动、右边收进12、宽度减少12、中心向左6；不是“整体左移12”。沿用同一变量可做补偿，不意味着必须复制数值；用户本次明确不做补偿。
- **真实主题善后**：用户明确不要求恢复此前四个旧主题值，备份问题不再是本件阻断。接续验收未再次重置主题、未改预设或持久化主题，未清数据、未删除会话。
- **前次翻译门禁首轮红灯不可抹去**：`agentWorkbenchSession.terminalDelivery.test.ts` 中 `expect(snapshot.summary?.elapsedMs).toBeGreaterThan(0)` 收到0；首轮 1 failed / 5318 passed / 1 skipped（5320）。未改源码，原样单文件复跑14 passed、全量复跑5319 passed / 1 skipped（5320）。这是观察到的非稳定红灯，不宣称已修复或已隔离历史根因。

## 当前未解问题

- 接续的真实“创建中”未执行：到达该态需真正创建会话，接续单 §5.9 明确禁止工作者自行创建或发送。需翻译分流，不以进入已有会话的动画代替创建中。
- 编辑左列在本次真实窗口没有打开；旧行为测试守卫保持绿，但不能冒充实机可用性取证。
- 窄视口600px时既有工作台最小宽360使 section.right=610；本件外框right=596、输入right=590，没有越出600，但不能把整个工作台称为无溢出。

## 接续结果（2026-10-10，待翻译；不标整单验收通过）

### 改动与边界

- 接续前半段已落 `WorkbenchChrome.css` 空态 `width:auto` / `margin-block:0` 与两条新CSS测试。本轮只加严新测试对横向定位补偿的排除，并更新本记录；既有测试未改未删。
- 共享右距仍只在 `ControlCenter.css` 定义。该文件、`builtin.ts`、`defaultPresets.solid.test.tsx` SHA-256 与本轮开工基线逐字相同；前件终端0、GUI/字段默认15、六条出厂15未再改。定向两文件27 passed（CSS14、预设13）。
- 统一公式：`O=B-R`、`cc.right=O-M`、`cc.left=L+M`。R只消费根上的现有12/14，未新增空态原点变量。空态720/32、top/transform、显隐和动画规则未改变。
- 多读：sidebar `useSidebarContributionProps.ts`，确认“在测试中新建会话”仅发预选广播并取消选择，不真正创建；`package.json`、`tauri.conf.json` 与工具README用于确认门禁、开发窗口和取证能力；快照脚本用于比较生成前后内容。Issue #266及BOARD已读，无本件新裁决。

### 最终五步关卡

```text
$ bun run lint
EXIT=0
$ bun run build:example-plugin
EXIT=0
$ bun run build
✓ built in 16.60s
EXIT=0
$ bun run check:solid
CSS 消费审计通过（注入 104 / 消费 336 / 声明 356，死注入与悬空引用均为 0）
EXIT=0
$ bun run test
Test Files 683 passed | 1 skipped (684)
Tests 5321 passed | 1 skipped (5322)
EXIT=0
```

较前件全量5320增加两条新用例，测试文件数仍684。此次首轮全绿；上次翻译首轮红/复跑绿的事实另保留，不称偶发已修。未动后端，按单本地免check:rust/check:clippy。

### 两条新测试反向验证

1. 临时恢复空态width:100%，只跑“空态只清纵向边距…”：`AssertionError: 空态外框又被强制全宽了（宽度应交由共享横向边距推出）: expected 'position:absolute;inset-inline:0;top:…' to contain 'width:auto'`；`workbenchChromeCss.solid.test.ts:228:49`；1 failed / 13 skipped，EXIT=1。
2. 临时移除共享右距的railWidth，只跑“唯一共享右距算式…”：`AssertionError: 共享右距算式丢了轨宽（右缘就不再落在滚动条左缘）: expected 'position:relative;flex-shrink:0;heigh…' to contain 'margin-right:calc(var(--cc-margin-x,2…'`；`workbenchChromeCss.solid.test.ts:244:8`；1 failed / 13 skipped，EXIT=1。

两次均用原始字节精确还原，恢复后27 passed、EXIT=0，再从恢复后的源码跑完整五步。完整红日志在仓外报告目录。

### 真实窗口矩阵（非克隆、非预览）

运行中Tauri dev进程读取静态dist，页面 `http://127.0.0.1:1430/`，`invoke=function`、`data-preview=false`；宿主未最小化，原视口1200×800、DPR2。最终build之后重载，CSSOM确认 `.is-empty` 的width:auto/margin-block:0及共享calc。开发窗口非内嵌发行成品，本轮未重编Rust或重启宿主；不得把这说成发行包复验。

| 真实状态 | 视口 | M | B / R / O | cc.left → right | 右公式误差 / rail误差 | 空态内容宽 |
|---|---:|---:|---|---|---|---:|
| 空态 | 1200 | 0 | 1200 / 12 / 1188 | 250 → 1188 | 0 / 无rail | 720 |
| 空态 | 1200 | 15 | 1200 / 12 / 1188 | 265 → 1173 | 0 / 无rail | 720 |
| 空态 | 600 | 0 | 610 / 14 / 596 | 250 → 596 | 0 / 无rail | 314 |
| 空态 | 600 | 15 | 610 / 14 / 596 | 265 → 581 | 0 / 无rail | 284 |
| 有会话 | 1200 | 0 | 1200 / 12 / 1188 | 250 → 1188 | 0 / 0 | — |
| 有会话 | 1200 | 15 | 1200 / 12 / 1188 | 265 → 1173 | 0 / 0 | — |
| 有会话 | 600 | 0 | 610 / 14 / 596 | 250 → 596 | 0 / 0 | — |
| 有会话 | 600 | 15 | 610 / 14 / 596 | 265 → 581 | 0 / 0 | — |

八组左公式误差均0。只临时覆写DOM的M，均恢复0px且pylon-theme全文未变。有会话为已有 `smu81i40f`，未发送消息。截图为当前真实空态宽/窄视口，不是离屏克隆。

进入已有会话的真实RAF采样：1200/M0进入41帧、1200/M15进入44帧、600/M0进入44帧、600/M15进入44帧；所有进入帧及前后空态/会话帧右公式、rail贴齐最大误差均0。横界分别保持250→1188、265→1173、250→596、265→581，仅纵向按原动画374→约704，完成后top689。未修改该既有纵向动画。

创建中未测，原因见当前未解问题；不把“进入已有会话”当作“创建中”。首次长采样结果超过工具64KB而截断，未计入有效证据；随后重新短采样并保存完整进入帧与汇总。

实机反向：同一真实空态DOM临时margin-right不含R，右公式误差0→-12→0；styleRestored=true。输入存在、可见、未禁用、中心命中自身。编辑列未打开，不冒充实机通过。

### 快照、说明书与清理

- 快照先确认无在途改动，保留前后原始内容，运行 `bun scripts/check-workbench-theme-contract.mts --write`：内置10、自定义0、字段176、变量87、fixture15、EXIT=0；`SNAPSHOT_CONTENT_EXCEPT_GENERATED_AT_EQUAL=True`。仅generatedAt变化，用生成前原始字节精确恢复，`EXACT_BASELINE_RESTORED=True`，未手改JSON或宽范围回退。
- 带问题检索说明书 `ccMarginX|边距零点|滚动条|scroll-rail|scroll-action-rail` 无命中，未发现需越界同步的既有表述。
- `Emulation.clearDeviceMetricsOverride`成功后视口回1200×800；临时边距右覆写为空、M回0px，采样globals=[]、probeNodes=0、probeStyles=0。未插入克隆/临时样式节点。回到原真实空态，session=null。
- 未关闭用户原有Pylon实例；未清数据、未删会话、未重置主题、未commit/push/开PR。

## 并行交集

本次只碰下列 4 个文件（+ 本记录）；`docs/说明书/` 无需同步。共享面提示：`WorkbenchChrome.css` / `ControlCenter.css` 属中控与工作台壳层样式，`presets/builtin.ts` 与 `defaultPresets.solid.test.tsx` 属预设域 —— 同期若有人在 D 档其它件动这两个 CSS 文件，需以本件为基线。

## 交叉复核（第二个工作者会话，2026-10-10；只追写，不改动上方任何结论）

> 同一工作树上有两个会话先后处理本接续单：**A 会话**落 `WorkbenchChrome.css` 空态 `width:auto` / `margin-block:0` 与两条新 CSS 用例；**B 会话**在 A 的基线上加严这两条用例（剥注释后再断言、补 `margin-inline-*` 与裸 `left|right|inset` 禁用项）并写下上方「接续结果」。本段是 A 会话在**同一最终源码**上的独立复核。

- 定向：`workbenchChromeCss.solid.test.ts` + `defaultPresets.solid.test.tsx` = **27 passed**（CSS 14 / 预设 13）。
- 五步门禁（加严后的最终源码）：lint / build:example-plugin / build / check:solid 全 `EXIT=0`；`bun run test` = `Test Files 683 passed | 1 skipped (684)`、`Tests 5321 passed | 1 skipped (5322)`、`EXIT=0` —— 与上方数字一致。
- 真实窗口矩阵（A 会话独立测得，与上方八组**逐位相同**）：空态 1200/M0 `250→1188`、1200/M15 `265→1173`、600/M0 `250→596`、600/M15 `265→581`；有会话同；`B − cc.right − M = R` 全部成立、有会话另满足 `rail.left − O = 0`；空态内容宽 720 / 720 / 314 / 284。
- 进入会话采样（A 会话，20 秒窗 / 2401 帧）：空态段 `position:absolute` top 374 → `is-session-entering` 45 帧 / 355ms（top 374→704，横向不变）→ 有会话段 `position:relative` top 689；全窗 `left / right / margin-right` 各为单值（250 / 1188 / 12px）。
- 反向验证（A 会话，两条各自独立、各自还原）：空态改回 `margin:0` ⇒ 红 `src/renderers/solid-workbench/__tests__/workbenchChromeCss.solid.test.ts:229:35`；共享右距去掉轨宽 ⇒ 红 `同文件:241:8`；还原后定向 27 绿。
- 快照：剥 `generatedAt` 内容全等（前后均 163327 字节），仅时间戳行变动，单文件还原，未手改 JSON。
- 清理：视口覆写已清（1200×800 / dpr2）、DOM 内联 `--cc-margin-x` 还原 `0px`、临时全局已删、`.control-center` 计数 1、无本会话注入的样式节点。
- 实机环境限制：A 会话验证期间该 `tauri dev` 实例被关闭**两次**（非本会话命令所致）；其中一次由 A 会话按 README 以 `bun run tauri dev` 重新拉起后继续取证，两端实例跑的是同一份 `dist`。「创建中」态 A / B 两会话均未验（须真正新建会话，接续单 §5.9 禁止自行执行）。

## 03替代单（2026-10-10；工作者自审完成，待翻译独立核验）

### 最终结构与留撤表

- `.solid-agent-workbench`为一行两列grid，左`minmax(0,1fr)`、右唯一`--scroll-action-rail-width`。左`.solid-workbench-content-column`是相对定位纵向flex，包含空态/会话chat-shell、中控、回放遮罩。唯一rail为共同外层直接子节点、第二列全高stretch；空态不挂rail本体但保留同一grid列。
- R仅在两列分配扣一次；消息viewport和中控均在左列。中控共享`margin-inline:var(--cc-margin-x,20px)`，预览无两列也只取M。`ControlCenter.css`相对本轮开工撤掉M+R，最终已回到HEAD的对称margin规则，因此最终git status不再显示该文件修改；不是没有执行撤销。
- 保留根轨宽12/14、端点16、所有外观；端点变量移到rail自身基础/窄屏作用域。创建浮层删除旧补偿变量声明、空态例外及消费，统一inset:0。空态width:auto/margin-block:0、720/32、纵向规则与动画保留。
- builtin.ts及defaultPresets测试与本轮开工备份逐字相同（`PRESET_BYTES_UNCHANGED=True`）；终端默认0、GUI/字段默认15、六条出厂15未再次修改。

### 测试处置与真实输出

- 修改点名的3条workbenchChromeCss既有用例，保留空态内容/纵向检查。
- 按追加授权，仅同步ChatView.css测试`anchors empty-state brand and creation progress to the chat viewport`的两处旧布局断言，新增局部剥注释变量；品牌与减动效断言及其它用例不改，用例数仍31。这是旧布局契约同步，不是删除或隐藏失败。首次读码发现冲突后停工，获追加授权后才修改。
- 新增3条mount测试；mount107、CSS14、预设13、ChatView31，四文件定向165 passed。
- 三条逐一反向：添加chat-shell旧rail路径→DOM用例红（1347）；controller寻道赋值破坏为0→行为用例红（1377）；creating绕过内容列类→创建结构用例红（1415）。各`EXIT=1`，随后`EXACT_BYTES_RESTORED=True`；controller仅反向临时变异，无最终改动。首个变异脚本因CRLF匹配未发生而断言失败，已修脚本后重跑，未把该脚本失败算测试红。

```text
bun run test <本单四文件> EXIT=0
Test Files 4 passed (4)
Tests 165 passed (165)
bun run lint EXIT=0
bun run build:example-plugin EXIT=0
bun run build EXIT=0
✓ built in 9.60s
bun run check:solid EXIT=0
CSS 消费审计通过（注入 104 / 消费 335 / 声明 355，死注入与悬空引用均为 0）
bun run test EXIT=0
Test Files 683 passed | 1 skipped (684)
Tests 5324 passed | 1 skipped (5325)
```

与旧5322相比新增3条，未删/跳过既有测试；本轮完整五步首次全绿。未改src-tauri，按本单免本地Rust/clippy。完整命令/输出与三个原始红日志在本单仓外报告目录。

### 实机来源、几何与截图

真实Tauri dev窗口`http://127.0.0.1:1430/`，调试目标`23765525ADA27B33B6E54BEB6EF36315`，`invoke=function`、preview=false。最终五步build后reload；CSSOM确认grid/wrapper/relative stretch rail/纯M margin/旧浮层变量缺席。该开发窗口读取静态dist，未重编Rust、未重启/关闭用户应用，不冒充内嵌发行成品验收。开始时宿主确实最小化，Windows窗口恢复后回1200×800；结束保持可见便于用户验收。

| 真实状态 | 视口/M | 内容列right | cc.left→right | rail top→bottom | rail宽 |
|---|---|---:|---|---|---:|
| 有会话 | 1200/0 | 1188 | 250→1188 | 44→800 | 12 |
| 有会话 | 1200/15 | 1188 | 265→1173 | 44→800 | 12 |
| 有会话 | 600/0 | 596 | 250→596 | 44→800 | 14 |
| 有会话 | 600/15 | 596 | 265→581 | 44→800 | 14 |
| 空态 | 1200/0 | 1188 | 250→1188 | 无rail，右列保留 | 12 |
| 空态 | 1200/15 | 1188 | 265→1173 | 无rail，右列保留 | 12 |
| 空态 | 600/0 | 596 | 250→596 | 无rail，右列保留 | 14 |
| 空态 | 600/15 | 596 | 265→581 | 无rail，右列保留 | 14 |

会话原选择`smv20axno`，中控top689/bottom785，chat.bottom689，workbench.bottom800，rail.bottom800>cc.top；不是旧rail.bottom689。消息壳、viewport、创建浮层right均等内容列right。15组（包含重复宽M0、侧栏、受控rightInset及回放）几何最大误差0。

实际右栏展开：工作台right940，column/rail.left928，rail.bottom800；左栏收起：left0、rail仍1188→1200/44→800。受控非零host rightInset以临时DOM变量100px输入：工作台border right1200，实际可用right1100，column/rail.left1088；全部公式误差0，style精确还原。这是受控输入，不说成生产右栏走100px。

宽窄完整截图均在仓外报告目录，文件名`真实有会话-宽窗-完整底部.png`、`真实有会话-窄窗-左栏收起-完整底部.png`。窄窗左栏收起后column/rail.left586，rail.right600、完整底端可见。600px且左栏展开时既有最小宽360造成工作台right610，rail596→610被视口裁掉10px，未修、不得声称整体无溢出。

### 实机行为、不变项与等级区分

- 当前会话短、不足以滚动：按授权在现有viewport末尾临时插3000px非持久化DOM内容，不改原消息节点/数据。scrollHeight3135、clientHeight645、max2490；trackHeight724、thumb148.953125，理论148.956938，渲染误差<0.004px。
- 真鼠标底端按钮→top2490；顶端按钮DOM点击→top0.5（smooth端点<1px）；真鼠标track中点→top1245；真实Home键→0；真鼠标thumb拖半旅行→1245。中控top689/bottom785在滚动前后不变。
- 临时中控高度160→clientHeight581、thumb134.171875（理论134.176715）；窗口高度700→track624、thumb108.476563（理论108.478469），证明比例和轨高刷新。全部临时输入恢复，原viewport节点保留、临时节点0、scrollTop0。
- 空态真实来自既有无工作区“新建会话”入口，该入口仅清选择/预选广播；未提交首条消息、未创建会话。空态cc top374/bottom470，中心422等于内容列中心422；body宽720/720/314/284，保留内容约束。
- 进入已有原会话采样169帧、entering45帧，top374→689；全部原点/rail上下缘误差0。仅进入已有会话，不称创建中。
- 创建中以deferred createSession受控组件测试观察creating class、aria-busy、禁用输入、进度层与稳定wrapper、解除后viewport注册移交；不是生产IPC实测，不向真实Agent发送验收消息。
- 真实History回放前先核对原会话periId，在存档菜单选择同一已存在会话（19:11:54条目），会话id仍smv20axno、id集合完全未变；ccCount0、rail44→800、chat44→800。切其它既有会话再回原会话退出只读；未归档/创建/删除数据。回放控件接线功能另由新增行为测试覆盖。
- 编辑：现有设置“进入布局编辑器”开关，输入栏属性入口可见且命中、dialogVisible=true、底端按钮命中true；列x0→280，rail1188→1200，不遮右列。退出后pylon-theme原文与进入前完全一致；未拖拽/改元件属性。进入编辑自动关闭设置Sheet，结束重新打开原设置并回原Agent页；临时History页关闭。

### 快照、说明书、自审与善后

- 快照先存原字节，脚本重拍：内置10、自定义0、主题字段176、变量87、fixture15，EXIT0；`SNAPSHOT_CONTENT_EXCEPT_GENERATED_AT_EQUAL=True`，仅generatedAt变，原始字节恢复`EXACT_SNAPSHOT_BASELINE_RESTORED=True`。未手改JSON、无快照最终文件需追加。
- 样式消费/声明计数336/356→335/355，是删除creation-overlay-right-inset单一旧变量的实际变化；快照只反映其本身的数据面，不将计数变化隐藏成“全部0差异”。
- 按问题查docs/说明书中CC-18、两列/右列、滚动条、ccMarginX及chat-shell/WorkbenchContent，无相关既有布局表述需更新；命中的canonical存储“两列元数据”不属于UI。未改说明书。
- 自审自己复核diff，未派评审子agent。新增wrapper完整迁移原Show/中控/回放；控制器/ScrollRail最终无改；ChatView只改点名两处；预设两个文件原字节不动。
- 最终测得：1200×800/session smv20axno/scrollTop0/中控1/编辑列0/临时节点0/探针全局已清/左栏展开/右栏收起/主题原文不变/rail44→800。未关闭用户应用，未commit/push/PR/外部评论。
- 控制台查询error/exception返回0，但缓冲buffered=0，不能据此证明整轮无控制台历史错误；后端当前session error查询返回0，受ringbuffer容量约束。工具参数/窗口恢复辅助步骤曾失败，均不属于产品测试失败，报告保留。

### 最终文件范围与状态

本单实际触碰7个授权文件：WorkbenchContent、WorkbenchChrome、ControlCenter、mountSolidWorkbench测试、workbenchChromeCss测试、ChatView.css测试、开发记录。ControlCenter恢复HEAD而不显示最终差异。最终工作树8条：2个保留预设草稿 + 5个本单源码/测试差异 + 1份开发记录；没有额外文件。

本单工作者自审及翻译独立核验通过，用户最终视觉验收通过（2026-10-10，原话“没问题”）。本单验收结单，用户随后明确授权提交、推送、PR与CI；未授权合并。旧失败与历史限制原文保留，上方“当前未解”是旧接续阶段的当时事实，由本段的新验收等级与结果接替。

### 翻译最终独立核验

- 五步关卡独立按序重跑，全部 EXIT=0：lint、build:example-plugin、build、check:solid、test；文件683 passed / 1 skipped（684），用例5324 passed / 1 skipped（5325）。
- 当前真实宽窗rail top44/bottom800，工作台top44/bottom800，中控top689/bottom785；窄窗左栏收起rail586→600、top44/bottom800。独立M0/15、rightInset0/100矩阵最大误差0。
- 亲测消息viewport Home为0、半程寻道/拖拽1245（max2490），中控top689/bottom785保持；测试内容仅临时DOM，不写会话，已清理。编辑属性入口可见并可点，退出后主题原文不变。
- 工作者15组原始几何独立重算最大误差0，169过渡帧含45进入帧；反向红日志已核对，不冒充翻译亲跑全部过渡或三次变异。
- 最终原会话smv20axno、scrollTop0、编辑列0、临时节点/全局0、视口1200×800、左栏展开/右栏收起，用户应用保持开启。
- Issue处置：本PR仅完成#266总账的CC-18，不关闭#266；其它CC事项及600px左栏展开既有裁切不属于本件。创建中仅受控组件测试，非生产IPC实测；本次静态dist开发窗口，非发行包重打包。
