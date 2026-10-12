# Pylon 插件开发套件（正常版 + 离线版）

同一套 SDK 源码提供两种使用路径：TypeScript/Node 构建使用正常版包，
无 Node、无源码环境使用离线版单文件 runtime。本套件自包含正常版 SDK、
离线 starter、说明书和自检脚本，解压后即可开始插件开发。

前置条件：一台已安装 **Pylon ≥ 0.3.0-AUE** 的机器（插件最终在 Pylon 里启用和验证）。

## 两套 SDK

| 形态 | 适用场景 | 入口 |
| --- | --- | --- |
| 正常版 | TypeScript/Node 构建、编辑器类型检查、单元测试 | `sdk/package.json`：`@pylon/plugin-sdk` 与 `@pylon/plugin-sdk/testing` |
| 离线版 | 发行包内纯 JS 开发，不安装 Node 或构建工具 | Pylon 安装目录 `resources/sdk/pylon-plugin-sdk.js`，相对 import |

正常版和离线版由仓库的 `npm run build:plugin-sdk` 同时生成，运行时 helper
共享同一源码；离线版刻意不包含 testing harness、类型声明或宿主运行时闭包。

## 30 秒路径（纯 JS，零工具链）

1. 复制 `starter/no-build/` 为你的插件目录（改个目录名即可）；
2. 改 `pylon-plugin.json` 的 `id` / `name`（id 全局唯一，建议 `作者.插件名`）；
3. 编辑 `index.js`——`activate` 里已经演示了命令、Hook、存储、设置页四个面；
4. Pylon「设置 → 插件」→ 安装目录 → 启用。

不需要 Node，不需要打包器：入口是纯 ESM，`import './pylon-plugin-sdk.js'` 相对引用随包 SDK。

## TypeScript 路径（starter/typescript）

- 需要自备 Node ≥ 18；
- `src/index.ts` 用 `import ... from '@pylon/plugin-sdk'`；`sdk/package.json` 的 `exports` 自动提供 runtime 与类型；
- `npm install`（装 esbuild 与 TypeScript 6.0.x）→ `npm run typecheck` → `npm run build` → 安装 `dist/` 所在目录；
- 不想装 esbuild 也行：包内 `dist/index.js` 是预构建产物，直接安装即可。

两种 starter 的源码即文档：五个最常用面（命令 / Hook / 会话元数据 / Scope 纪律 / 隔离设置页）各有一段带注释的最小代码。

## 套件结构

| 路径 | 内容 |
| --- | --- |
| `sdk/package.json` | 正常版 npm-compatible 包清单（`.` 与 `./testing` exports） |
| `sdk/pylon-plugin-sdk.js` | 正常版 SDK runtime（Node/TS 构建时由 bundler 消费） |
| `sdk/testing.js` | 正常版测试基建（`createMockContext` 等，见 §6.11.1） |
| `sdk/types/` | 完整类型声明树（TS 作者编辑器补全） |
| `sdk/types/sdk/testing.d.ts` | `@pylon/plugin-sdk/testing` 的入口声明 |
| `sdk/pylon-plugin-manifest.schema.json` | `pylon-plugin.json` 校验/补全 schema |
| `starter/no-build/` | 纯 JS 起步插件 |
| `starter/typescript/` | TS + esbuild 起步插件（含预构建产物） |
| `starter/manager-demo/` | 外置插件管理器示例（api 1.2 + 能力声明 + 用户授权，含预构建产物） |
| `docs/` | 开发者版 / 用户版说明书、CLI 命令表、设置选项贡献 |
| `verify.mjs` | 自检：结构完整性 + SDK 导出 + 类型探针（需 Node ≥ 18） |

自检：`node verify.mjs`（可选；通过会打印 PASS 清单，包含两个 exports 入口和声明树检查）。

## 能力声明与用户授权（API 1.2，starter/manager-demo）

API 1.2 起插件可在 manifest 声明**宿主能力**（封闭词表，当前只有 `plugin.management`），
经用户在宿主「设置 → 插件」页批准后，activation context 才会装配对应的增强 API：

```jsonc
// pylon-plugin.json
{
  "api": "1.2",
  "capabilities": ["plugin.management"]
}
```

- **门控语义**：未声明或未授权时 `context.management` 属性**不存在**（不是空对象）；
  授权后每次 API 调用现查授权，失效即抛 typed 错误（`management_not_authorized`）。
- **授权生命周期**：host-owned 存储；插件 `version` 变更后旧授权失效须重新批准；
  卸载时授权自动回收；拒绝则插件保持"等待授权"状态（不报错，可稍后批准）。
- **`plugin.management` 能提供什么**：只读（已安装清单 / runtime 概览 / bootstrap 概览 /
  契约诊断 / 贡献面透视）与管理操作（启停 / 重载 / 卸载 / 安装 / 内置组件启停）。
  目标为调用者自身的管理操作会被拒绝（`management_self_locked`）；
  product-required 内置包不可停用（`management_product_required`）。
- **manager-demo 就是一个完整样例**：同一套纯 DOM 管理面板以内嵌
  （`builtin.pylon-plugin-manager`，随宿主启动）与外置（本示例，目录安装）两种形态运行；
  未授权时面板显示授权引导而非报错，批准后经宿主"重试"自然激活。
  安装路径：设置 → 插件 → 安装/更新包 → 选择 `starter/manager-demo/` 目录。

## 测试你的插件（可选，需要 Node）

```bash
npm i -D vitest
```

```ts
// my-plugin.test.ts
import { definePlugin } from '@pylon/plugin-sdk'
import { createMockContext } from '@pylon/plugin-sdk/testing'

const ctx = createMockContext({ pluginId: 'my.plugin' })
const plugin = definePlugin({ /* 你的 activate */ })
await plugin.activate(ctx)
await ctx.__commands.execute('your.command.id', { /* args */ })
```

测试基建使用说明见 `docs/Pylon-插件系统说明书-开发者版.md` §6.11.1。

## 契约速查

- 清单：`schema: 1`、`api: "1.0"`–`"1.3"` / `"2.0"`–`"2.4"`（1.1 才有 `context.storage`；1.2 才有
  `capabilities` 能力声明与用户授权；2.0 起左栏贡献按 `region` 注册，allowlist 全表见
  说明书 §6.11.3）、kind 十选一；
- 生命周期：`activate` / `deactivate`（可选 `prepare` / `suspend` / `resume`）；
- 所有副作用（定时器 / 事件监听）走 `context.scope.*`，停用时自动回收；
- 样式：选择器以插件前缀类名限定，颜色间距用宿主语义 token（§6.4.2）；
- 只安装来源可信的插件——插件是本机受信代码，宿主不做恶意代码沙箱。

完整契约（16 章）见 `docs/Pylon-插件系统说明书-开发者版.md`；SDK 用法集中在 §6.11，
离线发行包目录与打包验收见 `docs/Pylon-发行包清单.md`。
