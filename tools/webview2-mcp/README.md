# pylon-webview2-mcp

面向 Pylon（Tauri 2 + Windows WebView2）的 **MCP 调试服务器**。

一句话：**让 AI 客户端「看进」正在运行的 Pylon 窗口**——控制台报错、网络请求、DOM 与计算样式、
截图、真实点击与输入，以及 Tauri 宿主侧的命令、事件、窗口状态与后端日志。
做法是用一个独立进程，通过 WebView2 自带的 `--remote-debugging-port` 反连标准 CDP 端点。

**你需要的东西**：本 README 同目录下的 `pylon-webview2-mcp.exe`，加上一个正在运行的 Pylon。
**不需要源代码**——这个 exe 是独立进程，不往 Pylon 里塞任何东西。

```text
MCP 客户端 ──stdio(JSON-RPC 2.0)──► pylon-webview2-mcp ──CDP/WebSocket──► Pylon.exe (WebView2)
```

---

## 目录

- [一、它能干什么](#一它能干什么)
- [二、接入](#二接入)
- [三、接入 MCP 客户端](#三接入-mcp-客户端)
- [四、拉起调试窗口](#四拉起调试窗口)
- [五、工具参考（24 个）](#五工具参考24-个)
- [六、已知限制](#六已知限制)
- [七、故障排查](#七故障排查)
- [附录 A：接线语义为什么是这样](#附录-a接线语义为什么是这样)

---

## 一、它能干什么

| 我想知道 / 我想做 | 用哪个工具 |
| --- | --- |
| 界面为什么白了 / 报错了 | `webview_console`（控制台 + 未捕获异常）、`tauri_backend_logs`（后端日志） |
| 某个接口到底返回了什么 | `webview_network` → `webview_network_body` |
| WebSocket 帧级往返还对不对 | `webview_websocket`（连接级事件 + 每帧一条，保持次序） |
| 这个按钮为什么点不动 | `webview_query`（盒模型/计算样式/可见性）、`webview_click` 的 `hitIsSelfOrDescendant` |
| 「当前界面长什么样」 | `webview_screenshot`（可整页、可裁剪） |
| 想按「用户看到的东西」定位元素 | `webview_snapshot` → 拿 `ref` 喂给 click / type / key / select / hover |
| 复现一次真实操作流 | `webview_click` / `webview_type` / `webview_key` / `webview_hover` / `webview_scroll` / `webview_select`，中间用 `webview_wait` 同步 |
| 后端某个命令返回什么 | `tauri_invoke`（等价于页面里 invoke 任意已注册命令） |
| 某个事件到底有没有发出来 | `tauri_event_catalog` 扫出事件名（**需要源码**）→ `tauri_events` 订阅读增量 |
| 窗口装饰/缩放/最大化这些 DOM 拿不到的属性 | `tauri_window_state` |
| 本体没包装的 CDP 域（`DOM.*` / `CSS.*` / `Emulation.*` / `Performance.*`） | `webview_raw_cdp` |
| 同时跑了好几个 Pylon，谁用哪个端口 | `webview_targets` 配 `scan_ports: true` |

**边界**：走标准 CDP 的部分（`webview_*`）全部可用；`tauri_*` 依赖页面里客观存在的
`__TAURI_INTERNALS__`，因此仍要求 app 是 Tauri 应用。

---

## 二、接入

### 1. 带调试端口启动 Pylon

启动 Pylon 时，把调试参数用环境变量带上（**这次启动**生效）：

```powershell
# PowerShell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222 --remote-allow-origins=*"
.\pylon.exe
```

```bat
:: 命令提示符（cmd）
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 --remote-allow-origins=*
pylon.exe
```

WebView2 只在启动时读这个参数，运行中开不了——所以换端口、或忘了带，都得关掉重开。
**#330 起产品二进制不再内置调试端口**（0.2.1–0.4.x 曾在 WebView2 环境参数里内嵌
`--remote-debugging-port=9222`，发行包同样对同机进程开放）；环境变量是唯一开启通道，
debug 与 release 构建一致。
细节与验证见[四、拉起调试窗口](#四拉起调试窗口)。

### 2. 把服务器配进 MCP 客户端

见[三、接入 MCP 客户端](#三接入-mcp-客户端)。MCP 客户端会在需要时自己拉起本进程，
**不需要手动启动**。

### 3. 自检

在客户端里依次调用：

1. `webview_targets` → `reachable: true`，且至少有一个 page 目标
2. `webview_evaluate`，表达式 `1 + 1` → 返回 `2`
3. `webview_evaluate`，表达式 `typeof window.__TAURI_INTERNALS__.invoke` → 返回 `"function"`
4. `tauri_window_state` → `tauriHostAvailable` 为 true、`tauriHostErrors` 为空
5. `tauri_invoke`，`{"command":"list_runtime_logs","args":{"query":{"limit":5}}}` → 返回日志数组
6. `webview_screenshot` → 返回一张能看懂的图
7. `webview_snapshot` → 返回「角色 + 名字 + ref」的文本树；挑一个 `ref=eN` 传给 `webview_click` 应能点中

第 3 步同时说明两件事：CDP 通道通了，且 Pylon 内部的 Tauri 接口没被改过语义。

---

## 三、接入 MCP 客户端

传输方式 **stdio**：客户端拉起进程，在 stdin/stdout 上讲 MCP（JSON-RPC 2.0，一行一条报文）。
支持协议版本 `2024-11-05` / `2025-03-26` / `2025-06-18`。

### 配置

`command` 填 `pylon-webview2-mcp.exe` 的**完整路径**。它就在你解压出来的 Pylon 目录里
（`pylon.exe` 所在的那个目录）：

```text
pylon-<版本>-win64/                  ← 解压出来就是这个目录
├── pylon.exe
├── WebView2Loader.dll
└── tools/
    └── webview2-mcp/
        ├── pylon-webview2-mcp.exe   ← command 要指到它
        └── README.md                ← 你正在读的这份
```

把下例里的 `<Pylon 目录>` 换成上面那个目录的完整路径（即 `pylon.exe` 所在目录），其余照抄：

```json
{
  "mcp": {
    "servers": {
      "pylon-webview2": {
        "type": "stdio",
        "command": "<Pylon 目录>/tools/webview2-mcp/pylon-webview2-mcp.exe",
        "enabled": true
      }
    }
  }
}
```

例如解压在 `<解压目录>/pylon-<版本>-win64`（占位示例，替换为你自己的实际路径），这一行就写成（JSON 里用正斜杠，或把反斜杠写成 `\\`）：

```json
"command": "<解压目录>/pylon-<版本>-win64/tools/webview2-mcp/pylon-webview2-mcp.exe"
```

> 注意：文档里刻意写成占位形式而不是某个具体盘符路径——`scripts/pack_release.py`
> 的发行审计会拒绝包内文本文件出现「盘符 + 冒号 + 斜杠」形态的本机绝对路径，
> 以免把维护机路径带进发行包。

存盘后重启客户端。

### Claude Desktop / 其它客户端

通用 stdio 形态（顶层 `mcpServers`）：

```json
{
  "mcpServers": {
    "pylon-webview2": {
      "command": "<Pylon 目录>/tools/webview2-mcp/pylon-webview2-mcp.exe",
      "args": []
    }
  }
}
```

**`command` 要填到 exe 本身**，不是它所在的目录——客户端会直接执行这个文件。且 `command`
是字符串、`args` 是字符串数组（不要写成 `"command": ["exe", "--port", "9222"]`，
那是另一种客户端的方言）。

**`cwd` 只在你有 Pylon 源码时才需要**：`tauri_event_catalog` 靠它定位源码目录
（默认扫描 `src` 与 `src-tauri/src`）。没有源码就整个省掉这一项，其余工具不受影响。

### 命令行参数

MCP 客户端通常不带参数直接拉起。参数只用于本地手动调试，以及一台机器上跑多个实例时错开端口。

```text
--host <地址>         调试端点地址（默认 127.0.0.1）
--port <端口>         调试端点端口（默认 9222）
--timeout-ms <毫秒>   单次 CDP 调用默认超时（默认 20000）
--cwd <目录>          tauri_event_catalog 扫描源码的根目录（默认当前工作目录）
-h, --help / -V, --version
```

`--port 9222` 与 `--port=9222` 两种写法都接受。`--help` / `--version` 先于一切校验：
即使别的参数写错，它们也会正常回答。

手动确认这个 exe 自身能跑：

```powershell
.\pylon-webview2-mcp.exe --help      # 打印用法与前置条件
.\pylon-webview2-mcp.exe --version
```

**服务器所有诊断输出都走 stderr，stdout 只承载协议报文。** 往 stdout 混一个字符，
客户端就会在解析层炸掉，而错误现场看起来跟本服务器毫无关系——手动调试时别往它的 stdout 打印东西。

---

## 四、拉起调试窗口

**不需要改任何文件**，只在这一次启动生效——启动前把参数放进环境变量：

```powershell
# PowerShell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222 --remote-allow-origins=*"
.\pylon.exe
```

```bat
:: 命令提示符（cmd）
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 --remote-allow-origins=*
pylon.exe
```

WebView2 **只在启动时**读这个参数，运行中开不了——所以每次要调都得这样带一遍。
这也正是「一次性」的好处：不写进任何配置，事后无需清理，不会影响别人正常启动的 Pylon。

验证端口真的开了：

```powershell
Invoke-RestMethod http://127.0.0.1:9222/json/version      # 返回 Edg/<版本> 即可
```

MCP 侧则调 `webview_targets`：端点不可达时它**不报错**，而是返回 `reachable: false` 并附开启步骤。

两个注意：

- **一个端口只能被一个 WebView2 进程占用。** 同时开两个 Pylon 会撞端口，第二个连不上。
  要多实例并行，就给每个实例换一个端口号，并把对应端口用 `--port` 告诉本服务器。
- **别把 `--disable-features=...` 抄进环境变量。** 环境变量是**追加**在 Pylon 自带参数之后的，
  抄进来会得到两串重复参数。原因见[附录 A](#附录-a接线语义为什么是这样)。

### 安全代价

**打开端口 = 把该窗口的完整代码执行能力交给同机任何进程**：连上就能执行任意 JS，
进而调用任意已注册的 Tauri 命令（读写文件、跑 agent 那类都在内）。所以只在调试时开，
**用完关掉 Pylon 就收工**。

---

## 五、工具参考（24 个）

### 通用约定

- **`target`**（可选，几乎所有工具都有）：目标 id / id 前缀 / url 或 title 子串。
  只有一个页面目标时可省略；多目标时省略会报 `ambiguous_target` 并列出全部候选。
- **`timeout_ms`**（可选）：覆盖服务启动时的默认超时。
- **读增量工具**（`webview_console` / `webview_network` / `webview_websocket` / `tauri_events`）
  共享一套窗口参数：
  - 默认只返回「上次读过之后」的增量。**典型用法是先做动作再读，不要反复全量拉。**
  - `since_seq` 显式指定起点（不推进游标，便于无副作用重读同一段）；
  - `limit` 最多返回多少条命中记录（默认 50）；`scan` 最多检视多少条（默认 `limit×20`，上限 3000）。
    两者分开是为了让「最近 50 条 error」不必因为中间夹着上千条 info 而搜不到；
  - `reset: true` 先清空缓冲并把游标推到末尾，即「从现在开始看」；
  - 连接断开重连后缓冲从零开始，返回体的 `reconnected` 会明确告知。
- **返回体编码随大小切换**：结构化结果紧凑序列化不超过 4,000 字符时逐行 pretty
  （便于定位字段），超过则输出单行紧凑 JSON——缩进对 50 条日志级别的结果放大的
  token 数不再「可以忽略」（2026-09-21 起，#218 上下文瘦身的一部分）。
- **`ref`**（快照 ref，如 `e12`）：由 `webview_snapshot` 产出，可直接喂给
  `webview_click` / `webview_type` / `webview_key` / `webview_select` / `webview_hover`。
  比 CSS 选择器稳——角色与名字是用户看到的东西，不随 DOM 结构变化。
  ref 只在最近一次快照之后有效：页面重载、或元素被重新渲染（列表虚拟化、条件挂载）都会失效，
  那时会明确提示「请重新快照」。要抗结构变化就用选择器。
- **只读标记**：13 个工具带 `readOnlyHint`，客户端可据此做权限提示或自动放行。
  划分口径是**对被调试 app 的影响**：`webview_evaluate` / `webview_click` / `webview_type` /
  `webview_navigate` / `tauri_invoke` / `tauri_events` 都会改 app 状态，**不**标只读。
- **失败形态**：工具自身的失败（端点没起来、选择器没命中）走 `isError: true` 的内容块，
  结构是 `{isError, error, detail, hint, tool?}`——`error` 是稳定机读码，`detail` 是散文，
  `hint` 是下一步建议。**不是** JSON-RPC 错误，所以 agent 能读到原因并自行调整。

### 页面级（19 个，走 CDP）

| 工具 | 用途 | 主要参数 |
| --- | --- | --- |
| `webview_targets` | 列出可附加目标 + 浏览器/协议版本。**排障第一步**，也是「端口通不通」的探针（端点不可达时返回 `reachable:false` + 开启步骤，不报错） | `include_workers`、`scan_ports` |
| `webview_evaluate` | 求值 JS 并返回值。默认包成 async IIFE，可直接写 `await` | **`expression`**、`wrap`、`await_promise`、`return_by_value` |
| `webview_raw_cdp` | 直调任意 CDP 方法，返回原始 result。覆盖未包装的域，也是「某方法在当前版本是否可用」的探针 | **`method`**、`params` |
| `webview_console` | 控制台消息 + 未捕获异常 + 浏览器日志 | `type`、`pattern`、增量窗口 |
| `webview_network` | 网络请求日志；同一 requestId 的四个事件合并成一条记录 | `resource_type`、`pattern`、`status_min`、`failed_only`、增量窗口 |
| `webview_network_body` | 按 requestId 取响应体；base64 解码后再判断是否为文本 | **`request_id`**、`max_chars` |
| `webview_websocket` | WebSocket 流：连接级事件与**每一帧**各占一条，保持往返次序 | `pattern`、`payload_pattern`、`direction`、`phase`、`request_id`、增量窗口 |
| `webview_dom` | DOM 结构轮廓（标签/id/class/属性，可选盒模型与文本）。走自序列化，不受 nodeId 失效影响 | `selector`、`max_depth`、`max_nodes`、`include_text`、`include_rect` |
| `webview_query` | 单元素详查：盒模型、计算样式、可见性、祖先链、滚动尺寸 | **`selector`**、`props` |
| `webview_snapshot` | 无障碍快照：角色 + 可访问名 + `ref` 的文本树 | `selector`、`max_nodes`、`include_values` |
| `webview_screenshot` | 截图，返回图片内容 | `full_page`、`format`、`quality`、`clip` |
| `webview_click` | 真实鼠标事件点击，**附带命中测试**（`hitIsSelfOrDescendant` 为 false 即被遮挡） | `selector` \| `ref` \| `x`+`y`、`button`、`click_count`、`mode`、`settle_ms` |
| `webview_type` | 输入文本；受控组件可能拒绝，返回体带输入后的实际值 | **`text`**、`selector` \| `ref`、`clear`、`mode`、`delay_ms`、`submit` |
| `webview_key` | 派发命名按键或单个 ASCII 字符，可组合 `modifiers` 发快捷键 | **`key`**、`selector` \| `ref`、`modifiers`、`repeat`、`settle_ms` |
| `webview_hover` | 悬停（只派发 `mouseMoved`），触发 hover 菜单 / tooltip；附带与 click 相同的命中测试 | `selector` \| `ref` \| `x`+`y`、`settle_ms` |
| `webview_scroll` | 滚动窗口或容器（滚进视口 / top / bottom / 绝对 / 相对），返回三个层面的滚动后位置 | `selector`、`to`、`x`、`y`、`dx`、`dy` |
| `webview_select` | 选中 `<select>` 选项，派发 input + change 让受控组件同步 | `selector` \| `ref`、`value`、`label`、`index` |
| `webview_wait` | 动作之间的**同步原语**，替代「点击后盲等固定毫秒」 | `selector`(+`hidden`) \| `condition` \| `href_contains` \| `ready`、`poll_ms`、`timeout_ms` |
| `webview_navigate` | goto / reload / back / forward | **`action`**、`url`、`ignore_cache`、`settle_ms` |

加粗的参数是必填。更细的参数语义（枚举值、默认值、互斥关系）在 `tools/list` 的
`inputSchema` 里，每个字段都带说明——agent 可直接读。

### Tauri 宿主侧（5 个）

| 工具 | 用途 | 主要参数 |
| --- | --- | --- |
| `tauri_invoke` | 调用任意已注册的 Tauri 命令（等价于页面里 invoke）。失败时同时给可读 `error` 与 `errorRaw` | **`command`**、`args` |
| `tauri_events` | 订阅并读取事件增量。**必须显式给出事件名**（原因见[已知限制](#六已知限制)第 1 条） | `events`、`buffer_size`、`target_kind`、`target_label`、增量窗口 |
| `tauri_event_catalog` | 扫描 **Pylon 源码**，列出 emit / listen 调用点上的事件名（**没源码就用不了**，见[已知限制](#六已知限制)第 2 条） | `roots`、`pattern` |
| `tauri_window_state` | 窗口状态：宿主侧（装饰/可见性/最大化/缩放/显示器）+ DOM 侧（视口/DPR） | `label` |
| `tauri_backend_logs` | 读后端日志（调 Pylon 的 `list_runtime_logs`，与前端 RuntimeSheet 同源） | `level`、`source`、`session`、`search`、`limit` |

### 错误码

工具失败时返回的 `error` 字段是稳定机读码（文案会改，码是契约）：

| 码 | 含义 | 下一步 |
| --- | --- | --- |
| `debug_endpoint_unreachable` | 端点连不上：进程没起来，或没带 `--remote-debugging-port` | 调 `webview_targets` 拿开启步骤 |
| `no_targets` | 端口通了但没有可附加页面 | 窗口可能还没创建，稍后重试 |
| `ambiguous_target` | 有多个页面目标且未指定 `target` | 用返回列表里的 id 前缀 |
| `unknown_target` | `target` 匹配不上任何目标 | 调 `webview_targets` 取当前 id |
| `target_gone` | 调用途中断连（reload 或 app 重启） | 直接重试，下次会自动重连 |
| `cdp_error` | CDP 返回了 error 对象 | 用 `webview_raw_cdp` 复核该方法在当前版本是否可用 |
| `js_exception` | 页面 JS 抛异常 | 先看 `webview_console` 的上下文 |
| `timeout` | 超时；CDP 侧可能仍在跑 | 调大 `timeout_ms`，或改成先取句柄再轮询 |
| `bad_args` | 入参不合法（含未知工具名） | 按 `tools/list` 的 `inputSchema` 修正 |
| `io_error` | 本地 IO 失败 | — |

---

## 六、已知限制

写在这里是为了避免误判现象。

1. **事件订阅必须显式给出事件名，无法「全量捕获」。**
   Tauri 内部把 `invoke` 定义成既不可改写、也不可重新配置的属性，因此没法把它包装起来
   旁路记录所有事件。本服务器走的是「按名字监听 + 页内环形缓冲」，
   所以**你得先知道事件名**——通常靠 `tauri_event_catalog` 从源码扫出来，没有源码就只能靠试。
   返回里的 `dynamicSites` 会告诉你「事件名是动态拼出来的、扫不到」的位置有多少个。

2. **`tauri_event_catalog` 扫的是 Pylon 源码。** 它读传入的 `roots`（默认 `src` 与
   `src-tauri/src`），跳过 `node_modules` / `target` / `dist`。所以**手上没有源码时这个工具用不了**，
   连带 `tauri_events` 也只能靠猜事件名。扫描有预算上限（最多 2 万个文件 / 总计 128MB），
   用尽即停——返回里的 `truncated: true` 会明说清单不完整，不会假装扫全了。

3. **DOM 走自序列化而不是 `DOM.*` 域。** `DOM.getDocument` 的 nodeId 会被任何 DOM 变更作废，
   拿着旧 id 调用只会收到 "Could not find node"。自序列化一次性拿到全部且无句柄失效问题。
   需要 `DOM.*` / `CSS.*` / `Emulation.*` 时用 `webview_raw_cdp`。

4. **整页截图在部分 WebView2 版本上不支持。** `captureBeyondViewport` 失败时会自动退回视口
   截图，并在返回的说明里写清——不会整次失败，但也不会假装截到了整页。

5. **`reload` / `goto` 会清空页内注入状态。** 事件订阅与页内缓冲、以及快照的 ref 都会消失。
   `tauri_events` 的订阅已注册成「新文档注入」，新文档一建立就自动重建（注册状态见返回体的
   `reloadSubscription`）；ref 则需要重新 `webview_snapshot`。但 reload 期间的事件无法补回。

6. **`webview_evaluate` 撞上永不 settle 的 Promise 会超时。** CDP 侧可能仍在执行。
   这类场景请先取句柄再轮询结果，而不是直接 await。

7. **`webview_evaluate` 结果超过 64KB 会被换成 `__truncated` 信封**（带大小与前缀预览），
   而不是静默截断。需要完整原始结果时用 `webview_raw_cdp`。
   结果是 DOM 节点/函数等不可序列化对象时返回 `__unserializable` 标记而不是 `null`，
   避免把「拿不到值」误判成「值就是 null」。

8. **`tauri_window_state` 的宿主侧读数可能缺项。** 个别只读窗口命令若因权限或平台原因不可用，
   只会在返回的 `tauriHostErrors` 里逐条列出，不会让整张状态表失败——所以看到该字段非空时，
   是某一项没拿到，不是整个工具坏了。

9. **不提供宿主侧日志文件读取。** `tauri_backend_logs` 读的是 Pylon 后端自己的环形日志缓冲
   ——好处是它与界面上「运行日志」面板同源，能把「后端报了什么」和「界面显示了什么」对齐到
   一条时间轴；代价是容量有限，历史条目会被覆盖（返回里有说明）。

10. **`webview_snapshot` 的角色表是简化版**（常见标签 + 显式 `role=`），不做完整 ARIA 隐含角色推导。

11. **CDP 方法的可用性取决于本机的 WebView2 版本。** 所以别假设某个方法一定可用——
    工具报 `cdp_error` 时，先用 `webview_raw_cdp` 单独试一下那个方法。
    首次接入建议按[第二节的自检清单](#3-自检)走一遍：最后一步能过，就说明整条链路是通的。

---

## 七、故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `debug_endpoint_unreachable` | 端点连不上。确认 Pylon 在跑、且启动时带了调试参数（见[第四节](#四拉起调试窗口)）。`webview_targets` 会返回完整的开启步骤 |
| 设了环境变量但端口没开 | 用[附录 A](#附录-a接线语义为什么是这样)的 `Get-CimInstance` 看浏览器命令行：参数在 → 端口其实开了（检查变量拼写、端口号是否一致）；参数不在 → 确认变量确实传给了 `pylon.exe`（不是只设在当前 shell），并确认 Pylon 是关掉重开的 |
| 命令行里出现两串重复的调试参数 | 说明 Pylon 自带的启动参数里已经有它了，再叠环境变量就会重复——不致命，但只应留一种 |
| 想订事件却不知道有哪些事件名 | `tauri_event_catalog` 读的是**源码**目录，没有源码就用不了——见[已知限制](#六已知限制)第 2 条 |
| 端口冲突 / 连上的是别的 app | 一个调试端口只能被一个 WebView2 进程占用。给不同实例配不同端口并用 `--port` 指定；用 `webview_targets` 的 `scan_ports` 查清谁在哪个端口 |
| `no_targets` | 端口通了但没有可附加页面。窗口可能还没创建，稍后重试 |
| `ambiguous_target` | 有多个页面目标。用返回列表里的 id 作为 `target` 参数。注意 **id 每次启动都会变，别抄旧的** |
| `webview_console` 一直为空 | 事件域没打开。查看服务器 stderr——`Runtime.enable` 等失败会逐条打印原因 |
| 工具报 `target_gone` | 页面 reload 或 app 重启导致连接断开。`webview_console` / `webview_network` 的下次调用会自动重连（返回体 `reconnected: true` 标明缓冲从零开始）；其它工具直接重试即可 |
| 点了没反应 | 看 `webview_click` 返回的 `hitIsSelfOrDescendant`；为 false 即被遮挡 |
| ref 定位报「请重新 webview_snapshot」 | ref 只在最近一次快照之后有效：页面重载、或该元素被重新渲染（列表虚拟化、条件挂载）都会让它失效。重新快照即可；要抗结构变化就用选择器 |
| 调用等到超时，而不是立刻报 `target_gone` | 老版本上可能出现。本服务器每 15s 发一次 WS 心跳，10s 内没有 pong 就判定连接已死（半开连接：app 被强杀时 socket 常常不报错）。若端点从不回 pong（极旧版本），心跳会自行停用并在 stderr 说明 |
| MCP 客户端里只看到服务器名、没有 `mcp__...` 工具 | 服务器启动就失败了。用 `--help` 手动跑一遍看 stderr；检查配置里 `command` 是字符串还是被写成了数组 |

---

## 附录 A：接线语义为什么是这样

**环境变量是「追加」，不是「覆盖」。** 实测（WebView2 运行时 153.0.4234.32）：带环境变量启动后，
`msedgewebview2.exe` 的命令行里**同时**出现 Pylon 自己那组参数
（`--autoplay-policy=...`、`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`）
与 `--remote-allow-origins=* --remote-debugging-port=9222`。也就是说，运行时把环境变量的值
**追加**在了 Pylon 原有参数之后。Pylon 自己那组自 #330 起已不含调试端口，所以下面这条复核
命令里 `remote-debugging` 只可能来自环境变量——缺了它就说明这次启动没带端口。

这解释了第四节那条注意：既然是追加，就不需要（也不应该）把 `--disable-features=...` 抄进来
——那只会得到两串重复参数。

不想改任何东西就能复核这一点（只读，随时可跑）：

```powershell
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
  Select-Object -ExpandProperty CommandLine | Where-Object { $_ -match 'remote-debugging' }
```

> 版本边界：该合并行为属运行时的未文档化细节，实测于 153.0.4234.32。换 WebView2 版本前建议复核一次。
