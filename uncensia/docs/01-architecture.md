# 架构

一个 Node 进程提供 `/v1` 与 Web 静态页面。SQLite 保存应用状态，Pi JSONL 保存原生会话树，媒体和用户资源保存在数据目录。ComfyUI 与云端 API 是可选后端。

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

环境变量决定监听和目录，业务配置由设置管理。模型与默认绑定显式保存，不静默换后端。初始资源只为新安装创建；包更新按内容哈希判断用户所有权，保留编辑和删除。旧 main 数据格式在启动前明确拒绝，不能靠默认值补齐来假装迁移成功。

原生工具写入还可涉及配置的工作目录。不要把“应用数据位于 data”理解为 agent 只能写 data；实际能力范围由工具权限与工作目录约束。

## 数据表参考

以下仅保留表与列的速查，完整约束以 `src/server/store/schema.sql` 为准，`audit-doc-schema.ts` 检查列名一致性。FTS 与向量派生索引不另建业务真相来源。
```sql
CREATE TABLE meta (
  key, value
)

CREATE TABLE settings (
  key, value, updated_at
)

CREATE TABLE secrets (
  name, iv, tag, ciphertext, updated_at
)

CREATE TABLE sessions (
  token_hash, device, created_at, last_seen, expires_at
)

CREATE TABLE providers (
  id, name, base_url, auth, enabled, sort_order, created_at, updated_at
)

CREATE TABLE models (
  id, provider_id, name, model, enabled, pinned, agent_tool, reasoning, input,
  context_window, max_tokens, thinking_level, thinking_level_map, api_mode,
  kind, ops, params, system_prompt, temperature, top_p,
  pricing, compat, sort_order, created_at, updated_at
)

CREATE TABLE mcp_servers (
  id, title, enabled, command, url, args, env, headers, sort_order,
  created_at, updated_at
)

CREATE TABLE conversations (
  id, title, model_id, archived, roleplay, visual_continuity, created_at, updated_at
)

CREATE TABLE messages (
  id, conversation_id, seq, role, content, entry_id, created_at
)

CREATE TABLE runs (
  id, conversation_id, status, model_id, error, task_id, created_at, updated_at
)

CREATE TABLE background_tasks (
  id, conversation_id, prompt, model_id, run_at, status, run_id, error, state,
  created_at, updated_at
)

CREATE TABLE events (
  seq, run_id, conversation_id, type, data, created_at
)

CREATE TABLE approvals (
  id, run_id, conversation_id, tool_name, action, summary, detail, status,
  created_at, updated_at
)

CREATE TABLE memories (
  key, value, tokens, source_conversation_id, updated_at
)

CREATE TABLE files (
  id, name, mime, bytes, disk_path, sha256, conversation_id, source,
  embedding_status, embedding_error, page_count, width, height, created_at
)

CREATE TABLE chunks (
  id, file_id, idx, page, text
)

CREATE TABLE embeddings (
  chunk_id, file_id, model, dim, vector
)

CREATE TABLE image_assets (
  image_id, mime, width, height, provider, model, parent_image_ids, created_at
)

CREATE TABLE video_assets (
  video_id, mime, width, height, duration_ms, poster_image_id, provider, model,
  parent_image_ids, created_at
)

CREATE TABLE jobs (
  id, kind, op, model_id, model_name, conversation_id, status, progress, note,
  params, sources, assets, error, provider_job_id, created_at, started_at,
  finished_at, updated_at
)
```
