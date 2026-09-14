# 架构

一个 Node 24+ 进程（依赖内置 `node:sqlite`）提供 `/v1` 与 Web 静态页面。SQLite 保存应用状态，Pi JSONL 保存原生会话树，媒体和用户资源保存在数据目录。ComfyUI 与云端 API 是可选后端。

## 模块边界

| 模块 | 负责 | 主要复用 |
|---|---|---|
| HTTP | 鉴权、请求验证、SSE 与客户端契约 | Hono |
| Agent | 运行归属、上下文、审批、会话投影 | Pi AgentSession / SessionManager |
| Generation | 生成操作、适配器、job 状态、素材血缘 | 提供方协议与 ComfyUI |
| Tools | 搜索、记忆、资料交付、能力装配 | Pi 文件工具、MCP SDK |
| Retrieval | 提取、切块、关键词和向量检索 | parse5、SQLite FTS、LanceDB |
| Web | 对话、创作台、资料库、设置 | React、Radix |

入口是 `src/server/main.ts`，服务装配在 `services.ts`。运行环境、启动脚本、备份与升级统一见 [运行维护](12-operations.md)。

## 数据与真相来源

| 位置 | 内容与用途 |
|---|---|
| `data/uncensia.sqlite` | 配置、对话索引、当前分支消息投影、任务、文件登记、源向量、密钥密文 |
| `data/sessions-sdk/` | Pi JSONL 会话树，保留原条目、分支和不透明消息字段 |
| `data/master.key` | 解密 secrets 所需密钥，必须与数据一起备份 |
| `data/files/`、`data/assets/` | 文档、媒体、来源信息和缩略图 |
| `data/skills/`、`data/workflows/` | 用户可维护的技能与生成工作流 |
| `data/prompts/`、`data/skill-preferences.json` | 提示词与技能启停偏好 |
| `data/search-index/` | 可重建的 LanceDB 派生索引 |
| `run/`、`runtime/`、`dist/` | 本机日志/证据、安装的运行环境、构建产物 |

Pi 会话树是原始历史，SQLite messages 是当前分支的展示与搜索投影。切换分支后重投影，旧节点仍保留。events 是运行增量日志，流式 delta 会清理；不能把事件日志当作永久历史。

媒体由 files 登记、资产表记录血缘、jobs 保存执行快照。job 可不属于对话；删除对话不能把资料库仍保留的作品一并删除。文件与工作目录交付共用一条入库路径。

## 配置与鉴权

单用户实例，访问码首次生成并加密保存，可启用 TOTP。登录返回 Bearer token 与 HttpOnly cookie；cookie 写操作验证同源，敏感账户操作要求再次验证。密钥接口只返回是否配置，不返回原文。

环境变量决定监听和目录，业务配置由设置管理。模型与默认绑定显式保存，不静默换后端。初始资源只为新安装创建（种子的提供方与默认模型集见 `src/server/store/seed.ts`，包含对话、生图、编辑与视频的默认绑定）；包更新按内容哈希判断用户所有权，保留编辑和删除。旧 main 数据格式在启动前明确拒绝，不能靠默认值补齐来假装迁移成功。

原生工具写入还可涉及配置的工作目录。不要把“应用数据位于 data”理解为 agent 只能写 data；实际能力范围由工具权限与工作目录约束。

## 数据结构与源码

准确表结构见 [`schema.sql`](../src/server/store/schema.sql)，共享请求类型见 [`types.ts`](../src/shared/types.ts)。文档不重复维护整份 SQL。

| 目录 | 入口 |
|---|---|
| 服务装配 | `src/server/services.ts` |
| HTTP 与鉴权 | `src/server/http/` |
| 会话运行 | `src/server/agent/` |
| 生成后端 | `src/server/generation/` |
| 资料与检索 | `src/server/rag/`、`src/server/library.ts` |
| Web | `src/web/` |
| iOS | `native-ios/` |

项目将说明、资料和会话关联起来；成果记录引用版本，用户验收与模型检查分开持久化。相关协议见 [API](05-api.md) 和 [Agent](02-agent.md)。
