# 文档导航

[English](README.en.md) · [简体中文](README.md)

Web 1.0 的使用者说明在仓库根 [README](../../README.zh-CN.md)；本目录是契约与证据，不是商店介绍。历史回放结果单独保留，不能据此推断当前部署状态。

## 按问题阅读

| 问题 | 文档 |
|---|---|
| 产品要做到什么，用户怎样使用？ | [产品目标](00-product.md) |
| 如何判断一个方案是否符合项目方向？ | [设计原则](09-design-principles.md) |
| 如何运行、更新、备份与回退？ | [运行维护](12-operations.md) |
| 服务和数据如何组织？ | [架构](01-architecture.md) |
| 多轮、分支、上下文与取消如何执行？ | [Agent](02-agent.md) |
| 生图、改图、视频与任务如何接入？ | [生成](03-generation.md) |
| 模型、skills、文件、记忆、MCP 如何管理？ | [扩展能力](04-capabilities.md) |
| 客户端可以调用哪些接口？ | [HTTP API](05-api.md) |
| Web 与 iOS 各负责什么？ | [客户端](06-clients.md) |
| Pi 的哪些功能已接入，哪些没有？ | [SDK 宿主边界](07-harness.md) |
| 怎样从真实使用轨迹验收效果？ | [多轮验收](08-acceptance-patterns.md) |

## 下一轮改进设计

- [后端与 WebUI 对比研究](17-comparative-design.md)：基于当前代码和使用记录，对比 Hermes、ChatGPT、Claude、SillyTavern、Pi；记录待实现方案、优先级和验收用例。
- [Agent 工作能力升级](18-agent-delivery.md)：分批目标、测试门槛、本次实现与真实验收记录。

## 当前原生开发

- [SwiftUI 原生重建](15-ios-native.md)：当前 iOS 技术路线、功能覆盖范围、并行分工与验收状态。

## 历史证据与参考

- [产品重构验收记录](10-refactor-validation.md)、[main 对比审阅](11-main-review.md)：保留原始测量、失败和当时的提交/部署状态，都是有日期的快照。
- [社区技能调研](community-skills.md)、[连续创作参考](series-community.md)：记录采用的经验及其边界，不是功能完成清单。

## 文档维护规则

产品目标与设计原则表达预期；模块文档描述实际契约；验收记录给出证据。新增能力时同时更新对应模块和 API，界面入口写进客户端文档。版本、依赖、完整字段与数据库列以 `package.json`、共享类型和 schema 为准，避免维护第二套手写定义。

“实现了”“测试通过”“真实效果达标”“已提交”“已部署”分别记录。模型或网关限制必须先核对实际请求再归因；未验证的内容保持未验证。

- [中英文本地化维护](16-localization.md) · [公开 AIGC 演示](showcase/README.zh-CN.md)

## 改名后的旧安装升级

源码目录现为 `uncensia/`。先停止旧服务，再更新启动命令。将 `UNCENSIA_DATA_DIR` 指向原来的数据目录，或把完整数据目录迁移到 `uncensia/data/`；不要另建空白安装。`master.key`、媒体、会话与凭据必须一起保留。

现有 `luma.sqlite`、`LUMA_*` 环境变量、浏览器偏好、登录 cookie 和工作流声明继续可读。新配置使用 `UNCENSIA_*`，同时存在时以新配置为准。未修改的内置技能随包更新，用户修改和删除的内容保留；历史对话不为改名而重写。

原 Windows 开发机的数据、依赖、构建、日志与隧道运行时已归位到 `uncensia/`，数据库为 `data/uncensia.sqlite`。仅 `runtime/node` 链接到必须原位保留的 `luma/runtime/node`；`luma/data` 反向链接到新数据目录，让旧记录中的附件路径继续可读。旧启动文件与源码目录链接已移除。全新克隆不需要这些本机兼容链接。

- [iOS 历史加载优化](17-ios-loading-acceptance.md)：请求合并、按需分页、缓存回看与模型恢复实测。
