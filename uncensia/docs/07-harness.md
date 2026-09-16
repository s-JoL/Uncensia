# SDK 宿主边界

Uncensia 使用 Pi 的 AgentSession、SessionManager、DefaultResourceLoader、ModelRuntime 和 SettingsManager（进程内、不落盘，提供压缩、重试与转向/追问策略）。SDK 版本以 `package.json` 为准。执行流见 [Agent](02-agent.md)，本页只记录集成范围，避免把接入 SDK 说成完整兼容 Pi。

## 支持的契约

| 能力 | Uncensia 的映射 | 验证入口（scripts/） |
|---|---|---|
| 执行控制 | 流式、多轮工具、abort、steer、followUp | audit-harness-host、audit-product |
| 会话树 | 原生 JSONL、当前分支投影、HTTP fork/rewind/export | audit-sessions、audit-history-replay |
| 压缩 | SDK 自动/手动压缩，处理资源引用与技能程序 | audit-product、audit-harness-host |
| 技能 | SDK 发现、原生 read、显式命令、用户限定技能、启停偏好 | audit-skills、audit-settings-management |
| 原生工具 | 按当前权限提供文件与命令工具，附加审批和资料交付 | audit-coding、audit-library-lifecycle |
| 扩展消息 | custom message 保存、投影和 SSE，保留显示标记及顺序 | audit-harness-host |
| 扩展事件 | notify/status、工具 partialResult 通过持久事件送达 | audit-harness-host、audit-web-agent-events |
| 扩展对话框 | select/confirm/input/editor 落为 `questions` 行，经 `question.asked`/`question.settled` 事件与 `POST /questions/:id` 回答；run 停止或超时即撤销，confirm 只在回答 yes 时为真 | audit-harness-host |
| 扩展与包 | 本地 `extensions/` 文件与 Pi 包（npm、Git、本机路径）经 Pi 的 PackageManager 安装、更新、移除；启停偏好写入 `agent-resources.json` 并转为 Pi settings，加载结果记录到设置页 | — |
| 生命周期 | 等待初始化，关闭时停止接收新操作，排空工具和审批后清理 | audit-harness-host |
| 错误 | 加载、命令与清理失败可见，不伪装为完成 | audit-harness-host |

这些脚本使用真实 SDK 与隔离服务验证协议事实。真实模型效果、图片质量、当前部署和原生 iOS 的验收另行记录。

## 明确未覆盖的部分

- 扩展实例按 run 创建与清理，闭包和临时设置不跨 run 保留。写入原生会话条目的状态可持久化。
- HTTP 分支操作不等于 SDK 扩展的 newSession/fork/navigateTree/switchSession/reload hooks；相关宿主操作未完整映射。
- RPC UI 已映射 notify/status 与四种对话框；自定义 TUI 组件、编辑器操作、主题、终端输入等未实现方法明确失败。工具审批不能冒充通用扩展对话框，对话框也不能代替审批。
- 未提供完整扩展命令目录、补全、资源热重载、队列编辑及统计控制。包与扩展的改动在下一次 run 生效。
- 扩展内部切换模型/思考等级，尚未完整同步到 Uncensia 的持久模型配置。
- 扩展不能通过 ctx.shutdown 关闭共享服务；终端组件和按键绑定没有自动 Web 等价物。

`ctx.hasUI` 只表示已有可用事件绑定，不表示任意终端交互都受支持。显式 skill 展开块按 SDK 语法及精确名称/位置识别，展示标记不是调用来源的认证证明。

## 生命周期

会话实例按 run 重建，以读取最新模型、凭据、权限和分支，并隔离事件与取消信号。扩展若需要跨 run 状态，应写入持久会话条目。不要依赖闭包在下一次 HTTP 运行中继续存在。

## 产品能力与模型能力

媒体 job、资源身份、资料库与 UI 属于 Uncensia；Pi 集成覆盖不能代替这些产品验收。系列创作通过 skill、已有 job 和文件检查点执行，没有专用系列工作流引擎。

完整树导出不包含全部媒体，大规模检索性能与完整扩展兼容仍有边界。写作、有效长上下文召回、视觉理解与生成保真必须另看实际模型结果，不能用 SDK fixture 的通过代替。
