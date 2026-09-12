# iOS 流式交互与远端验收（2026-09-08）

基线：`s-JoL/Uncensia` 的 main `24c8da0`。原本地受版本控制的代码已重置，工作继续于 `uncensia/native-ios`。测试连接 `https://luma.liangsong.top`，使用专用验收对话。访问码和会话令牌不写入仓库。

## 本次修复

- 引用：修正 ICU 正则中的 Unicode 转义；同时支持实际 U+E202 和字面量 `\ue202`。来源索引随会话隔离，从已载入的工具结果重建；未解析的内部锚点不会显示成原始 ID。真实服务生成的搜索引用格式也已核对。
- 富文本与媒体：段落中间的图片、`[image image_id=…]`、`/v1/images/…` 和 `video://…` 可以显示，代码中的示例保持字面量。表格可跟在普通段落后，空单元格保留。图片与视频可打开原生预览，预览标题不再暴露长资源 ID。图片缩略图在后台解码并使用有容量上限的内存缓存，加载失败可重试。
- 流式状态：每个持久化消息事件收束为消息行；临时用户消息被真实消息替换；同一活跃运行的前台同步不再清空并重放正在显示的回答。切换会话取消旧订阅及待刷新的增量。完成后重新读取服务端结果。
- 阅读与输入：合并为单个输入框，输出期间可写追问或转向；追问失败保留草稿。上翻立即解除自动跟随，返回最新后恢复；滚动更新合并到后续帧，避免几何回调内反复修改滚动位置。支持键盘收起、代码复制和小屏输入。
- 连接：SSE 请求延长超时，HTTP 鉴权错误不再伪装成普通断流。保留已有 SSE 游标恢复与轮询回退。实测遇到一次远端 502，因此给 GET 和带幂等键的请求加入最多两次有限重试；普通写请求和鉴权失败不自动重试。Keychain 使用原子更新，避免并发轮换令牌时先删除后写入造成的空窗。
- 图标：原生操作图标使用与 WebUI 相同版本的 Lucide SVG，包含授权文件。仓库首页、Web 标识/favicon 和 iOS AppIcon 使用同一个 `src/web/assets/uncensia.svg` 品牌源。

## 当前验收证据

| 场景 | 结果 |
|---|---|
| iOS Simulator 签名构建 | 通过。必须保留模拟器 ad-hoc 签名才能使用 Keychain；构建脚本已修正。 |
| Web 生产构建、TypeScript 检查 | 通过。 |
| 引用隔离、混合媒体、表格、SSE UTF-8、草稿、消息去重等核心回归 | 15 项通过，0 失败、0 跳过；含 502 重试集成验证与 Keychain 并发令牌轮换。 |
| iPhone 17 Pro，真实长回复流式输出 | 通过。新回复到达后仍在生成，上翻、输入草稿、后台/前台恢复、返回最新均通过自动化检查，约 59 秒。 |
| iPhone 17 Pro，远端图片和视频预览 | 通过。上传测试图片和仓库中的短视频，模型返回图片 Markdown、图片占位符和视频 Markdown，实际原生预览已打开，约 21 秒。 |
| iPhone SE，真实长会话阅读与重启恢复 | 通过。上翻、返回最新、键盘输入及重启后的草稿恢复，约 23 秒。 |
| iPhone SE，持续输出与前台恢复 | 通过。独立会话收到真实正文后，上翻、输入草稿、后台恢复和返回最新均通过，约 36 秒。此前一次发送遇到 HTTP 502，已保留失败证据并补上有限幂等重试。 |

截图位于 [本次验收截图目录](shots/ios/acceptance-2026-09-08/)。其中模型生成的“测试标准”等正文只是测试内容，不是本客户端已达到的性能指标。

本次不宣称真机 60/120 fps、与 ChatGPT 完全一致或所有弱网条件均已通过。已完成的是上述模拟器交互与真实服务路径；尚未进行真机 Instruments 帧率/能耗量化、强制网络切换及超大视频压力测试。这里的实测结果不替代 [原生端完整功能矩阵](15-ios-native.md)。

## 重跑方式

```bash
bash uncensia/scripts/native-ios.sh prepare
bash uncensia/scripts/native-ios.sh build
node uncensia/scripts/sync-native-icons.mjs
```

`CoreTests` 和 `TranscriptRenderingTests` 不需要远端凭据。`RemoteAcceptanceTests` 为显式开启的测试：在测试 runner 的环境中设置 `UNCENSIA_SERVER_URL` 和专用验收会话的 `UNCENSIA_TEST_CONVERSATION_ID`，并先在目标模拟器登录。媒体验收需选择含测试图片和视频的专用会话。不要把生产会话用于会发送新消息的流式测试。

测试截图由 XCTest 导出；本机详细结果包：`/tmp/uncensia-stream-final.xcresult`、`/tmp/uncensia-media-final.xcresult`、`/tmp/uncensia-small-screen.xcresult`、`/tmp/uncensia-se-acceptance.xcresult`、`/tmp/uncensia-core-final.xcresult`。远端验收对话与上传测试素材暂留，便于人工复查。
