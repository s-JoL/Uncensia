# iOS 客户端

Uncensia 的 SwiftUI 客户端位于 `native-ios/`，支持 iPhone 与 iPad，最低 iOS 18。它连接现有 Uncensia 服务，不在手机上运行模型后端。

## 构建与安装

需要 macOS、Xcode、命令行工具和 XcodeGen。在 `uncensia/` 中执行：

```bash
bash scripts/native-ios.sh prepare
open native-ios/Uncensia.xcodeproj
```

在 Xcode 选择 Uncensia scheme 和目标设备。安装到真机时，在 Signing & Capabilities 中选择自己的开发团队，按需调整 bundle identifier，然后运行。仓库提供源码构建方式；是否有签名包或商店版本应以实际发布页面为准。

```bash
bash scripts/native-ios.sh build
bash scripts/native-ios.sh test
```

测试默认使用 iPhone 17 Pro 模拟器，可通过 `UNCENSIA_IOS_DESTINATION` 改变目标。测试夹具与真实服务测试有各自启用条件；跳过的测试不算验证通过。

夹具与真实服务测试默认跳过。先启动隔离后端（`UNCENSIA_IOS_FIXTURE_DIR=<空目录> node --import tsx scripts/ios-ci-fixture.ts`，默认端口 18090、访问码 IOS-CI-ACCEPTANCE），再以环境变量启用对应测试，例如 `UNCENSIA_IOS_FIXTURE=1 UNCENSIA_SERVER_URL=http://127.0.0.1:18090 UNCENSIA_ACCESS_CODE=IOS-CI-ACCEPTANCE bash scripts/native-ios.sh test`。脚本把 `UNCENSIA_*` 环境变量转成 xcodebuild 构建设置，scheme 再注入测试进程；直接在 Xcode 中运行时需自行在 scheme 的 Test Arguments 里添加同名变量。

## 连接服务器

在登录页填写手机可达的服务器地址和访问码；启用 TOTP 时再输入验证码。电脑上的服务必须运行，并能被手机访问。真机的 `127.0.0.1` 指向手机，不指向开发电脑。远程访问配置见 [运行维护](12-operations.md)。

登录凭据存入 Keychain；草稿按服务器与会话隔离。两个客户端共用会话、媒体、设置和任务。切换设备时继续打开同一会话，无需导出再导入。

## 当前界面

顶层是五个标签页；故事设定、分支、后台任务与成果评审是「对话」内的功能，记忆和定时任务归入「设置」。

| 标签页 | 实现内容 |
|---|---|
| 对话 | 流式正文、思考与工具状态、附件、停止、转向与追问、编辑重试、模型切换；菜单含对话设定、分支、后台任务、交付与反馈、整理上下文、继续、导出 JSONL |
| 创作台 | 服务端 schema 参数表单、原图/首帧与参考图、生成队列、作品画廊、来源与再次生成/调整参数、分享 |
| 项目 | 项目列表与详情：说明、关联资料（引用与解除）、归属对话、编辑 |
| 资料库 | 上传与从链接导入、按文件名筛选、文档内容检索（混合/语义/关键词）、笔记编辑、重新索引、原文与来源阅读、作为上下文或底图加入对话 |
| 设置 | 常用设置、连接服务、模型、扩展连接（MCP）、技能、工具与权限、定时任务、个性化、记忆、访问与登录 |

「对话设定」表单包含所属项目、故事资料（角色、你的身份、世界、场景、写作方式、示例对白，以及 Character Card V2 JSON 导入）和固定图片参考（视觉圣经与主体/场景/风格锚点）。「后台任务」面板针对当前对话，可创建一次性、持续或定期任务，查看进度与执行记录，暂停、继续和取消；全局定时任务在「设置」的定时任务分组统一查看。

界面使用原生导航、系统分享与文件选择。英语和简体中文跟随 iOS 应用语言设置。

## 渲染与恢复

历史分页加载，已完成消息使用稳定 ID；流式正文独立更新，Markdown 增量解析。上翻阅读时保持位置，返回底部后恢复跟随。工具结果的图片或视频若已嵌入同轮助手正文，只在正文位置展示；正文未引用的结果仍可见。

SSE 按游标恢复，可回退轮询。回到前台核对历史、运行和审批；失败与取消保留实际状态。图片和文档使用当前服务器的认证，不向外部链接转发令牌。

## 验证

文本解析与媒体引用见 `Tests/TranscriptRenderingTests.swift`；界面测试在 `UITests/`。`scripts/ios-ci-fixture.ts` 提供隔离后端，滚动与流式夹具用于可重复的延迟和恢复场景。交付前还需实际检查键盘、阅读位置、图片、分享及服务端写入结果，见 [测试指南](08-acceptance-patterns.md)。
