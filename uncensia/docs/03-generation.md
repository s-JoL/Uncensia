# 图片与视频生成

Chat 和 Studio 共用 `Jobs`、模型 schema、来源解析与资产存储。MCP 工具不进入 Studio；外部 MCP 仍可被 agent 调用。

## 操作与适配器

| 操作 | 输入 |
|---|---|
| `text_to_image` | 提示词 |
| `image_to_image` | 提示词、原图及可选参考 |
| `text_to_video` | 提示词及型号支持的参考 |
| `image_to_video` | 提示词、首帧及型号支持的尾帧或参考 |

模型可用操作由 adapter、`kind` 与 `ops` 共同决定。`apiMode` 选择协议：

| 适配器 | 用途 |
|---|---|
| `openai-images` | OpenAI 兼容生成与编辑 |
| `venice-images` | Venice 生成、编辑与多图编辑 |
| `comfy-workflow` | ComfyUI API 工作流及参数绑定 |
| `openai-videos` | OpenAI 兼容异步视频 |
| `venice-videos` | Venice 视频队列与结果读取 |
| `siray-media` | Siray 异步图片与视频 |

源码在 `src/server/generation/`。新增后端实现 `GenerationAdapter` 的 `schema`、`run`，以及可选的 `resume`（重启后重连异步任务）与 `cancel`，并在 `index.ts` 注册。内置 Siray 型号及参数见 `src/server/models/siray.ts` 和 [接入说明](13-siray.md)。

## 参数与模型选择

`adapter.schema(spec, op)` 同时供 Studio 和 agent 使用。Studio 使用完整字段；`forModel` 移除仅供界面（`audience: studio`）的参数，工具再补上进度说明用的 `intent`。参数校验在入队前完成，来源数量、顺序与文件存在性也必须有效。无效请求不会通过静默钳制、改尺寸或换模型继续执行。

通用创作方法放在技能，后端专属提示说明放在模型 schema。ComfyUI 工作流位于 `data/workflows/`；精确宽高需要成对有效，模型文件和自定义节点需由部署者安装。

`generate_image`、`edit_image`、`generate_video` 使用设置中的默认绑定。首次安装的默认绑定为托管 Siray：文生图 Seedream 5.0 Pro Spicy T2I、改图 Seedream 5.0 Pro Spicy I2I、视频 Wan 3.0 T2V；本地另外种入 ComfyUI · Lustify V10 Krea Turbo 供离线出图。显式绑定不可用时返回错误；只有未绑定时才从可用配置中选择。设置为 `agentTool` 的额外模型可提供具名工具。

视觉技能按需读取固定参考与上一张成功图片。代码不从提示词猜测来源，不自动将文生图改成编辑；来源 ID 与用途由明确调用决定。

## 任务与恢复

```text
queued → running → succeeded | failed | cancelled
```

每个 job 保存输入、提供方任务 ID、状态和成品。客户端重连读取同一任务；SSE 用于及时更新。ComfyUI 并发为 1，其他协议按车道并发为 3。

HTTP 读取可有界重试；提交丢失响应时先核对已提交任务，避免重复计费。重启后排队任务可重新入队，支持恢复且有提供方任务 ID 的异步任务继续轮询；无法认领的执行保留失败状态。取消本地等待不一定取消上游计算，取决于适配器能力。

Agent 用提交与等待组合，Studio 使用 `POST /jobs`；`POST /studio/run` 同步等待相同任务。`inspect_generations` 可分页检查本会话 job 的实际状态与输出，适合中断后继续组图。

## 作品与显示

图片和视频以 `GeneratedAsset` 返回；文件保存字节，资产表保存来源，job 保存成品快照。`/studio/gallery` 包含生成和上传媒体。图片支持缩略图，视频支持 Range，`provenance` 提供来源信息。

工具结果提供可靠的媒体引用；助手可在正文内嵌 `image://…` 或 `video://…`。客户端保留正文中的位置，并隐藏同轮重复的独立媒体。正文未引用的成品仍显示。

生成状态只证明执行结果；数量、人物连续性和画面质量还需看实际作品。公开演示的输入与成品见 [showcase](showcase/README.md)。
