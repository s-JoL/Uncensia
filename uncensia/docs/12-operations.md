# 运行维护

## 环境与启动

需要 Node 24+。可选的 `runtime/node` 为每台机器单独安装，不随仓库提供。通用前台启动方式见 [项目 README](../../README.md)。

Windows 的 `scripts/start.ps1` 和 macOS/Linux 的 `scripts/start.sh` 会构建 Web、启动服务并按配置开启隧道。具体参数以脚本为准；Windows `-Local` 仅本机访问，`-NoComfy` 保持现有 ComfyUI 不动。构建失败时不替换正在运行的服务。Node 由 `scripts/common.ps1` / `common.sh` 解析。

| 环境变量 | 用途 |
|---|---|
| `UNCENSIA_ROOT` | 应用根目录 |
| `UNCENSIA_DATA_DIR` | 数据目录，默认应用下的 `data/` |
| `UNCENSIA_HOST` / `UNCENSIA_PORT` | 默认 `127.0.0.1:8090` |
| `UNCENSIA_TRUST_PROXY` | 受信任反向代理后的来源和 HTTPS 判断 |

业务配置在界面与数据目录中管理。修改模型、技能或提示词通常从下一次运行生效；源码更新需要重新构建和重启。

## 当前格式的更新

1. 确认没有运行中的对话或生成任务，记录当前版本及部署方式。
2. 停服务后完整备份 `data/`，保存当前代码版本和 lockfile。不要只复制处于写入中的 SQLite 主文件，遗漏 WAL 或其他会话、媒体文件。
3. 更新代码，执行 `npm ci`、`npm run typecheck`、`npm run audit`、`npm run build`。
4. 在数据副本上用独立目录、端口验证启动和关键历史；不要同时让两个实例写同一目录。
5. 切换正式服务，检查 `/v1/health`、登录、历史、附件、模型设置与工具状态。

初始化只为新安装创建默认模型。包内技能、工作流和提示词更新按内容哈希判断所有权：保留用户编辑与删除，不用默认值覆盖个人配置。模型参考目录也不会在每次启动时改写保存的参数。

## 旧 main 格式

旧版把会话树保存在 SQLite；新版使用 Pi JSONL。未转换的数据会在启动时被拒绝，防止生成空历史掩盖问题。

仓库目前没有通用的一键转换工具。离线转换必须覆盖 schema、会话条目与分支、当前叶子、消息投影、素材引用、提示词和密钥；先在备份副本验证，再切换。不能仅添加字段绕过格式检查。

## 备份与回退

`data/` 包含密钥、原始会话、文件、媒体、技能、工作流和配置，应作为一个整体保存。凭据以 `data/master.key`（首次运行生成的 32 字节密钥，权限 0600）加密；脱离它单独复制 `uncensia.sqlite` 解不出任何密钥，所以密钥文件必须随数据库一起备份。LanceDB 搜索目录可重建，但它不能替代源文件和数据库。对话 JSONL 导出不包含全部媒体字节，不等于整机备份。

回退时停服务，将匹配的代码版本、依赖和备份数据一起恢复；不要拿旧程序直接打开已经转换的新格式。运行日志和本机证据在 `run/`，不提交私人数据或凭据。

## 检查边界

`audit` 使用临时数据和本机测试服务。真实模型检查、出图及视频测试可能产生费用，需要单独选择运行；具体轨迹与判定标准见 [验收](08-acceptance-patterns.md)。Web 小屏测试不替代 iOS 原生编译、键盘和手势测试。

## 让手机连接

默认仅监听 loopback。局域网使用可通过 `UNCENSIA_HOST` 指定监听地址，手机连接电脑的局域网地址与服务端口。远程使用应在受控 HTTPS 反向代理后提供服务；仅在可信代理后设置 `UNCENSIA_TRUST_PROXY=1`。不要将代理信任扩展到不受控来源。

访问码首次启动打印在日志中，也可用 `npm run access-code` 重新读取，或用 `UNCENSIA_ACCESS_CODE` 预设；设置可管理访问码、TOTP 与登录设备。新安装可用环境变量引导凭据：各供应商读取 `<ID>_API_KEY` 或 `<ID>_TOKEN`（即 `OPENROUTER_*`、`OPENCODE_*`、`SIRAY_*`、`COMFY_*`，两种命名任取其一），网页搜索用 `TAVILY_API_KEY`、检索嵌入用 `EMBEDDING_API_KEY`；也可全部在设置填写。环境凭据仅首次安装导入，且不覆盖已有保存值。

新安装种入四个供应商：OpenRouter、OpenCode、Siray、本地 ComfyUI。默认对话是 OpenRouter · GLM 5.3 Flash（`z-ai/glm-5.3-flash`），并一并置入 OpenCode · MuseSpark 1.3（免费档 `muse-spark-1.3-contributor-free`）；检索嵌入为 Qwen3 Embedding 8B。默认出图、编辑、视频都走托管 Siray——文生图与图生图均为 Seedream 5.0 Pro Spicy、视频为 Wan 3.0，只需一个 Siray key 即可立即生成。本地 ComfyUI · Lustify V10 Krea Turbo 也随之种入，但需另装本地 ComfyUI 及模型权重与工作流依赖，裸克隆无法运行。它们只是初始配置，不附带模型文件、配额或密钥；准确模型与参数见设置和 `src/server/store/seed.ts`。
