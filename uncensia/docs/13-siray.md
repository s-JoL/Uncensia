# Siray 接入

核对日期：2026-09-07。Base URL 为 `https://api.siray.ai/v1`，Bearer key 经 SecretVault 加密保存。
配置里只加入以下 Spicy 型号；官方目录的 Seedance 名为 **2.5 Spicy**，没有在名称中补造 Pro。

新安装默认值对齐当前配置：聊天为 OpenRouter GLM 5.2，生图为本地 Lustify，编辑为 Seedream，视频为 Wan 文生。
Siray 默认启用 Seedream 和 Wan 的三个入口；Qwen、Seedance 的配置保留但默认关闭。
Wan 首尾帧、多参考另外开放具名 agent 工具；默认编辑和默认视频直接使用各自的通用工具，不重复挂名。
已有安装仍保留自己的启用状态、参数、默认绑定及自定义提示词，不在启动时覆盖。密钥由各安装单独配置。

| 型号（含供应商前缀） | 操作 | 来源与输出参数 |
|---|---|---|
| `bytedance/seedream-5.0-pro-i2i-spicy` | 编辑图片 | 1–10 张图；16 种明确像素尺寸；jpg/png |
| `alibaba/qwen-image-3-pro-edit-spicy` | 编辑图片 | 1–3 张图；1k/2k；15 种画幅；seed、提示词扩写 |
| `alibaba/wan-3.0-t2v-spicy` | 文生视频 | 2–30 秒整数；480p/720p/1080p；6 种画幅 |
| `alibaba/wan-3.0-i2v-spicy` | 首尾帧视频 | 必需首帧、可选尾帧；同上 |
| `alibaba/wan-3.0-ref2v-spicy` | 多参考视频 | 最多 10 图、5 视频 URL、5 音频 URL；同上 |
| `bytedance/seedance-2.5-t2v-spicy` | 文生视频 | 4–30 秒整数；480p/720p/1080p；7 种画幅 |
| `bytedance/seedance-2.5-i2v-spicy` | 首尾帧视频 | 必需首帧、可选尾帧；同上 |
| `bytedance/seedance-2.5-ref2v-spicy` | 多参考视频 | 最多 30 图、10 视频 URL、10 音频 URL；另支持 -1 自动时长 |

所有视频支持 `audio_enable`。只有 Wan 声明 `seed` 与 `prompt_expansion_enable`，不会向 Seedance 发送这些字段。
实测 Seedance 首尾帧接口拒绝显式画幅（`InvalidParameter.TaskTypeConstraint`），虽然 OpenAPI 列出多种比例；此入口只允许 `adaptive` 跟随首帧，不接受后悄悄改写。
Qwen 上游支持 n=1–6；Uncensia 此入口固定 n=1，保持单次图片调用的交付约定。其他可选参数只用已声明的默认值。
完整枚举保存在型号 schema，创作台和 agent 共用，不以聊天关键词决定操作。

图片通过 JSON `images` 发送有序 data URI。视频首尾帧分别使用 `image`、`end_image`，多参考型号使用 `images`、`videos`、`audios`。
编辑图片没有接入 `/images/edits`，两款编辑型号都提交到 `/images/generations/async`。
提交后立即保存任务 ID；轮询在原提交路径后追加 `/{task_id}`。恢复只轮询已保存 ID，不重复 POST。
OpenAPI 示例将提交 ID 放在 `data.task_id`，实际响应也出现根部 `task_id`/`id` 与数字 `code`；官方 SDK 1.3.0 同样读取根部 ID。
因此按 HTTP 结果、任务 ID 和状态解析，不能仅比较 `code === "success"`。
成功后下载 `outputs` URL，不向输出主机发送 API key。没有可确认的任务 ID 时标记交付不确定，不自动重发。
官方未发布取消接口，本地停止等待不代表上游任务已取消。

## 验证

`scripts/audit-siray.ts` 无费用验证各操作的请求路径、字段、来源顺序、两种响应结构、失败、结果存储、凭证隔离和恢复不重复提交。
真实输出与实时目录仍需另行验证，协议测试不证明画面质量或供应商长期可用性。

## 官方依据

- [接口集成](https://docs.siray.ai/model-apis/api-integration)
- [完整文档目录](https://docs.siray.ai/llms.txt)
- [Seedream 编辑 OpenAPI](https://docs.siray.ai/api-reference/openapi-spec/seedream-5.0-pro-i2i-spicy.json)
- [Qwen 编辑 OpenAPI](https://docs.siray.ai/api-reference/openapi-spec/qwen-image-3-pro-edit-spicy.json)
- [Wan 首尾帧 OpenAPI](https://docs.siray.ai/api-reference/openapi-spec/wan-3.0-i2v-spicy.json)
- [Seedance 多参考 OpenAPI](https://docs.siray.ai/api-reference/openapi-spec/seedance-2.5-ref2v-spicy.json)
- [官方 JavaScript SDK](https://www.npmjs.com/package/siray)
