# SDK 宿主边界

Uncensia 使用 Pi 的 AgentSession、SessionManager、DefaultResourceLoader 和 ModelRuntime。SDK 版本以 `package.json` 为准。执行流见 [Agent](02-agent.md)，本页只记录集成范围，避免把接入 SDK 说成完整兼容 Pi。

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
| 生命周期 | 等待初始化，关闭时停止接收新操作，排空工具和审批后清理 | audit-harness-host |
| 错误 | 加载、命令与清理失败可见，不伪装为完成 | audit-harness-host |

这些脚本使用真实 SDK 与隔离服务验证协议事实。真实模型效果、图片质量、当前部署和原生 iOS 的验收另行记录。

## 明确未覆盖的部分

- 扩展实例按 run 创建与清理，闭包和临时设置不跨 run 保留。写入原生会话条目的状态可持久化。
- HTTP 分支操作不等于 SDK 扩展的 newSession/fork/navigateTree/switchSession/reload hooks；相关宿主操作未完整映射。
- RPC UI 已映射 notify/status；select、confirm、input、editor、自定义 TUI 等未实现方法明确失败。工具审批不能冒充通用扩展对话框。
- 未提供完整扩展命令目录、补全、资源热重载、队列编辑及统计控制。
- 扩展内部切换模型/思考等级，尚未完整同步到 Uncensia 的持久模型配置。
- 扩展不能通过 ctx.shutdown 关闭共享服务；终端组件和按键绑定没有自动 Web 等价物。

`ctx.hasUI` 只表示已有可用事件绑定，不表示任意终端交互都受支持。显式 skill 展开块按 SDK 语法及精确名称/位置识别，展示标记不是调用来源的认证证明。

## 为什么仍按 run 重建

每次运行需要一致地读取当前模型参数、密钥、工作目录、权限、资源及分支。工具闭包和事件接收器还携带本次 run 的身份与取消信号。直接缓存会话实例可能让撤销权限、模型更新或分支切换失效，也可能把新事件写进旧 run。

未来跨 run 复用须先实现原子配置刷新、工具撤权、事件归属、分支一致性、空闲释放和错误归属；不能仅把实例放入 Map 就宣称完成。现有回归已覆盖下一轮参数更新、撤权、文本模型移除看图工具、新旧 run 事件隔离、fork/rewind 保留原树。

## 产品能力与模型能力

媒体 job、资源身份、资料库与 UI 属于 Uncensia；Pi 集成覆盖不能代替这些产品验收。系列创作通过 skill、已有 job 和文件检查点执行，没有专用系列工作流引擎。

完整树导出不包含全部媒体，大规模检索性能与完整扩展兼容仍有边界。写作、有效长上下文召回、视觉理解与生成保真必须另看实际模型结果，不能用 SDK fixture 的通过代替。
