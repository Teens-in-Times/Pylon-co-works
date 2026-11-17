# Agent Operations · 团子调度局

独立 Pylon 前端插件：用基建场景和小人移动呈现任务派遣、工作、等待、异常与验收，提供产品经理维瑟兰的角色页、五套立绘和 Cubism 互动模型。

## 安装与使用

面向 Pylon Plugin API 1.0；当前验证宿主为 Pylon 1.6.0、提交 `d445deb0490028c9d5694007ad527470e93c6674`。

1. 将发布 ZIP 解压到独立目录。目录根部应有 `pylon-plugin.json` 和 `dist/`。
2. 在 Pylon 的“设置 → 插件”安装该目录并启用。
3. 打开右栏的“团子调度局”。角色与运行依赖随包提供，使用时不需要 Node、Python、Cubism Editor 或在线生图服务。
4. 先在 Pylon 建立可用 Agent 会话，再创建任务并选择小人派遣。也可以将待派遣任务拖到小人上。
5. 回合完成后任务进入待验收；点击验收才会放行依赖任务。自动派遣需要手动启动，重新加载后不会自行恢复。

等待权限时通过 Pylon 原生权限卡片处理。插件只观察真实事件，不代替用户授权，不把发送成功视为工作完成。当前验证宿主的 `interaction respond` CLI 存在 `permission`/`approval` 类型不一致；原生权限卡片流程已验证可用。

## 角色互动与当前制作状态

可以打招呼、思考、鼓励、休息、切换安静陪伴和暂停动画。Cubism 模型具有独立眼部、眉部、嘴形与嘴部开合、侧倾及互动反应；眨眼连续开合，侧倾使用有阻尼的回弹。安静陪伴停止嘴部说话动作，仍可眨眼。

当前为制作中的版本：头部 X/Y 转向、独立头发和身体物理、精细中间眼形及真正的衣装绑定仍待完善。五套衣装目前是独立立绘展示，尚不是互动模型换装。嘴部动作是无声反应，不是音频口型同步。不要将此阶段包标作最终完成的 Live2D 作品。

## 开发

在本目录运行：

```sh
npm ci
npm run build
npm test
npm run preview
```

预览位于 `http://127.0.0.1:4178/`，明确标示 DEMO，不调用真实 Agent。`npm run package` 构建可安装目录与 ZIP；产物位于 `release/`，并附有文件 SHA-256 清单。

插件通过 Pylon 已有的 Surface、Context Panel、Presentation Profile、Commands 和私有存储扩展接入。UI 使用 Shadow DOM，Cubism 位于独立 iframe；卸载清理事件、计时器、观察器与 WebGL 资源。Pylon 本体不需要修改。

## 来源与许可

详见 [第三方与素材说明](THIRD_PARTY_NOTICES.md)。角色介绍只包含本插件人格、喜好与厌恶，不包含其他作品原稿或背景。
