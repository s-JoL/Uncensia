# HTTP API

`GET /learning/history`：鉴权后读取最近 50 次 agent 长期行为修改尝试，包含原因、来源对话及新旧内容；记录先于写入保存，不等于成功状态。技能和提示词的常规编辑入口保持不变。

Web 与 iOS 使用同一 `/v1` API；下文路径均省略 `/v1` 前缀，例如健康检查完整地址为 `/v1/health`。请求和响应完整字段以 `src/shared/types.ts`、`src/server/http/routes/` 为准；本页描述入口与行为，避免复制第二套类型定义。

## 鉴权

`GET /health`、`GET /auth/challenge` 和 `POST /auth/token` 是公开入口；登录提交 `{ accessCode, totp?, deviceName? }`，返回 token 和 HttpOnly cookie。`POST /auth/logout` 作废当前会话。其余业务接口需要鉴权。

Bearer 与同源 cookie 均可用。Cookie 写请求检查来源；访问码、TOTP 和设备会话管理的敏感操作还需 step-up。密钥只写不读，响应仅表示是否已配置。

`GET /bootstrap` 提供客户端启动所需的模型、适配器目录、默认后端、能力、MCP 状态、提示词及上传限制。设置页复用服务端目录，不另行猜测可用协议。

## 对话与运行

| 方法 | 路径 | 契约 |
|---|---|---|
| GET/POST | `/conversations` | 列表 / 创建 |
| GET | `/conversations/search` | 当前可见分支正文搜索 |
| GET/PATCH/DELETE | `/conversations/:id` | 详情 / 修改 / 删除；可保存角色和视觉配置 |
| GET | `/conversations/:id/messages` | 按 seq 增量或分页读取 |
| POST | `/conversations/:id/runs` | 创建运行，支持幂等键、附件、模型、fromSeq 和 imageReferences |
| POST | `/conversations/:id/continue` | 继续当前对话 |
| POST | `/conversations/:id/stop` | 停止运行 |
| POST | `/conversations/:id/steer` | 当前轮后插入指令 |
| POST | `/conversations/:id/follow-up` | 当前回答后再处理指令 |
| GET | `/conversations/:id/tree` | 节点、父子关系、摘要和当前叶子 |
| POST | `/conversations/:id/fork` | 从 entryId 或当前节点创建分支对话 |
| POST | `/conversations/:id/compact` | 创建可取消的手动压缩运行 |
| GET | `/conversations/:id/export` | 原生 Pi JSONL 树，不含完整媒体字节 |
| GET | `/runs/:id` | 运行状态 |
| GET | `/runs/:id/events` | SSE；after 或 Last-Event-ID 续流，mode=poll 长轮询 |

新 run 返回 202 `{ runId, seq }`，seq 是本次事件产生前的水位。编辑/重试后从 `after=-1` 重拉当前投影。转向/追问要求活跃 run，否则 409；详细时序见 [Agent](02-agent.md)。

图片用途为 context/base/subject/scene/style/source，必须对应当前附件，只允许一个 base。无效模型、附件或配置在改写历史前拒绝。角色字段含 character/persona/world/scene/style/examples；示例独立保存，不冒充已发生剧情。完整限制见共享校验定义。

## 项目

`GET/POST /projects` 列表与创建 `{title,instructions}`；`GET/PATCH /projects/:id` 读取与更新，更新须提交原 `revision`，冲突返回 409。名称最多 120 字符，说明最多 32000 字符。

`GET /projects/:id/conversations` 列出所属会话；`GET /projects/:id/files` 提供带 `next_cursor` 的资料分页；`PUT/DELETE /projects/:id/files/:file` 添加/移除关联，保留文件原件。创建和 PATCH 会话接受可选 `projectId`（null 为普通对话），运行期间不能移动项目；分支继承归属。移入项目会关联该会话已生成的文件，旧项目的显式文件关联保留。

`GET /resources/conversations/:id/deliverables/:key/compare?from=1&to=2` 比较两个固定交付版本。UTF-8 文本按原始字节内容计算统一 diff，校验冻结版本哈希；媒体和文档提供原件预览，过大的内容明确返回未生成完整差异。单侧文本上限 256 KB，差异计算设耗时和编辑距离上限。

## 审批与定时任务

| 方法 | 路径 | 契约 |
|---|---|---|
| GET | `/approvals` | 全局待审批 |
| GET | `/conversations/:id/approvals` | 对话待审批，status=all 查看全部 |
| POST | `/approvals/:id` | `{ approved }` |
| GET | `/background-tasks` | 全部对话的后台任务，含进度和当前 run |
| GET/POST | `/conversations/:id/background-tasks` | 列表 / 创建 `{ prompt, runAt?, modelId?, mode?, intervalMs?, maxRuns? }`；mode 为 once / continuous / interval |
| PATCH | `/background-tasks/:id` | `{ action: "pause" \| "resume" }`；暂停不打断当前轮，恢复受状态和轮数上限约束 |
| DELETE | `/background-tasks/:id` | 取消后续执行并请求停止对应 run，保留结果 |
| GET | `/background-tasks/:id/runs` | 最近 100 条实际执行记录 |

## 生成、文件与媒体

| 方法 | 路径 | 契约 |
|---|---|---|
| GET | `/studio/tools` | 可用生成操作和 schema |
| GET | `/studio/gallery` | 作品及分页信息 |
| POST | `/studio/run` | 同步等待同一份 JobInput，返回 job |
| GET/POST | `/jobs` | 列表 / 提交，提交返回 202 |
| GET | `/jobs/:id` | job 完整状态 |
| POST | `/jobs/:id/cancel` | 取消 |
| GET | `/jobs/:id/events` | SSE 推送 job 状态，无历史事件重放 |
| GET/POST | `/files` | 筛选分页 / multipart 上传 |
| POST | `/files/notes` | 新建文本笔记 |
| GET/PUT | `/files/:id/text` | 读取 / 修订文本 |
| GET/DELETE | `/files/:id` | 元数据 / 删除 |
| GET | `/files/:id/content` | 原文件，download=1 下载 |
| POST | `/files/:id/reindex` | 重建索引 |
| POST | `/files/search` | 检索，fileIds 限定范围 |
| GET | `/images/:imageId` | 图片，w 选择缩略图 |
| GET | `/videos/:videoId` | 视频，支持 Range |
| GET | `/images/:id/provenance`、`/videos/:id/provenance` | 来源与血缘 |

`GET /jobs` 支持 status/conversationId、1–200 的 limit 和返回的 nextCursor。文件与图库用 offset 分页。文档同源响应保持 sandbox 策略，媒体 URL 使用 cookie 鉴权。

资料原文使用 `GET /resources/files/:id`（start/end/encoding）；不可变摘录为 `GET /resources/quotes/:id`，来源为 `GET /resources/sources/:id`。`GET /resources/conversations/:id/evidence` 返回当前交付、反馈和最近 30 次请求证据；没有新式请求证据的旧 run 只展示最后一次工具装配。

`GET /resources/conversations/:id/deliverables/:key/versions` 返回历史版本。`POST .../:key/review` 接收 `{ revision, status: "accepted" | "rejected" }`，版本、原件或状态冲突返回 409；该接口由用户界面调用，模型交付工具不能设置用户验收字段。`POST /resources/feedback` 接收 conversationId/seq/text。Web 的“任务与成果”在展开时自动更新，保存反馈和运行结束也触发刷新。

## 设置与记忆

| 资源 | 接口 |
|---|---|
| 记忆 | GET `/memory`；PUT/DELETE `/memory/:key` |
| 提供方 | GET/POST `/providers`；PATCH/DELETE `/providers/:id`；PUT/DELETE `/providers/:id/key` |
| 在线模型目录 | GET `/providers/:id/models` |
| 模型 | GET/POST `/models`；PATCH/DELETE `/models/:id`；POST `/models/bulk` |
| 模型参考 | GET `/model-reference?model=...`；未知型号返回 reference: null |
| 默认模型 | PUT `/models/default`、`/models/generation-defaults` |
| 技能 | GET/POST `/skills`；PATCH `/skills/:id` |
| 能力 | GET/PATCH `/capabilities`；PUT/DELETE `/capabilities/secrets/:name` |
| 提示词 | GET `/prompts`、`/prompts/defaults`；PUT `/prompts` |
| MCP | GET/POST `/mcp/servers`；PATCH/DELETE `/mcp/servers/:id`；POST `/mcp/reconnect` |
| 安全 | GET `/security`；PUT `/security/access-code` |
| TOTP | POST `/security/totp`、`/security/totp/confirm`；DELETE `/security/totp` |
| 设备会话 | DELETE `/security/sessions/:id`；POST `/security/sessions/revoke-others` |

技能创建提交 `{ content }`；编辑提交 `{ content, revision }`，启停提交 `{ enabled }`。正文仅可编辑本地技能，版本冲突返回 409。模型容量要求有效整数，批量参数验证失败时不留下部分新增行。

错误统一为 `{ error: { code, message } }`。错误信息给用户和模型解释真实原因，不吞成完成；是否重试由具体接口的幂等性及任务状态决定。
