# 用 Uncensia 制作一段小电影

[English](README.md) · [简体中文](README.zh-CN.md) · [返回 Uncensia](../../../README.zh-CN.md)

黄色雨衣人物是 2026-09-08 专门为公开展示生成的虚构角色。没有使用私人对话、记忆、参考照片或已有作品。

| 步骤 | 实际后端 | 输出 |
|---|---|---|
| 生成站台人物 | ComfyUI · Lustify V10 Krea Turbo | 1536 × 1024 PNG |
| 将人物移动到海岸 | Siray · Seedream 5.0 Pro 图片编辑 | 1248 × 832 PNG |
| 让站台人物动起来 | Siray · Wan 3.0 图生视频 | 1280 × 720 MP4，4 秒，无声 |

![站台人物](01-midnight-platform.png)

![海岸编辑](02-coastal-morning.png)

![动态预览](03-departure.gif)

[原始视频](03-departure.mp4) · [实际提交参数](manifest.json)

## 如何复现

先在 Uncensia 配好相应模型。首图使用的 ComfyUI 工作流需要 `lustify_v10_krea_turbo_int8_convrot.safetensors`、`qwen3vl_4b_fp8_scaled.safetensors`、`wan_2.1_vae.safetensors` 及工作流声明的节点类型。采用 8 步、CFG 1、Euler、beta 和 shift 4，图片种子为 `9082026`。

1. 在创作台选择生图和 Lustify，复制参数清单第一项的提示词与尺寸。
2. 选择图片编辑和 Seedream，将第一张图作为源图，使用第二项提示词与 `1248x832` 尺寸。
3. 选择 Wan 首尾帧图生视频，以**站台图**为首帧，不是海岸编辑图。使用最后一项提示词、4 秒、720p、16:9，关闭声音和供应商提示词扩写。

清单中的素材 ID 属于这个独立演示安装；复现时请在自己的安装中选对应源图。云端运行可能产生费用。服务商更新和生成随机性意味着相同参数也可能得到不同结果。

这些任务通过 Uncensia 的真实队列和适配器，在独立数据目录中提交。两张图片均已实际看图检查，MP4 的尺寸、时长和代表帧也已检查。编辑保留了可辨认的发型、雨衣、围巾与摄影风格，同时改变姿态和环境。这是一个展示案例，不是保证所有姿态下身份完全一致的基准测试。

GIF 是 MP4 的较小动态预览；原始图片和服务商返回的原始 MP4 单独保留。参数清单只包含公开提示词和参数，没有凭据或服务商下载地址。

## Web 界面截图

`web-studio.png`、`web-studio.zh-CN.png` 和 `web-edit.zh-CN.png` 均为隔离演示实例的真实浏览器截图，展示上方三件作品。输入框内容用于展示操作流程，截图过程没有提交新的生成任务。演示实例不含私人对话，生成结束后已移除云端凭据。
