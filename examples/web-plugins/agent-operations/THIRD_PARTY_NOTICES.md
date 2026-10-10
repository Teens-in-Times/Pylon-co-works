# 第三方与素材说明

## Live2D

使用官方 Cubism SDK for Web 5-r.5 的 Framework 与 Core。Framework 许可见 `vendor/live2d/FRAMEWORK-LICENSE.md`；安装包中为 `dist/licenses/live2d/FRAMEWORK-LICENSE.md`。Core 的许可与可再分发文件清单位于 `art/live2d/CORE-LICENSE.md`、`art/live2d/RedistributableFiles.txt`，安装包中对应 `dist/art/live2d/`。

Core 不是本插件自有源码，不按其他库的开源许可证再授权。模型由官方 Cubism Editor 5.3.04 制作、保存和导出；没有使用 5.4 alpha 输出作为分发模型。

## Anime2.5DRig

来源：https://github.com/852wa/Anime2.5DRig

固定提交：`7450341934a8ff77bf05b90d9f708786e3eb3996`。使用其 `lib/runtime.js` 的分步弹簧计算实现角色侧倾回弹。文件原样保存为 `vendor/anime25d/runtime.cjs`，MIT 许可及来源说明随源码和安装包附带。没有使用该项目的样例 PSD、角色图片或通用闭眼素材。

## 制作工具研究

AutoLive2d 与 see-through 在插件外的独立研究目录评估。当前安装包不包含推理环境或模型权重，也不会将角色图像上传到这些服务。其自动分层结果尚未通过画质验收、尚未替换随包模型。

## 角色与生成素材

维瑟兰是用户提供的原创角色；原图、用户参考素材及生成的衣装图不因代码仓库或依赖库的许可证而自动获得开放素材授权。角色图像用于本插件展示，相关角色和原画权利保留给原权利人。五张衣装图属于本次制作的生成素材；角色形象一致性和最终视觉质量仍在调整。
