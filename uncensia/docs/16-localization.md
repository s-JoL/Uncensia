# Localization / 本地化

[English documentation](README.en.md) · [中文文档](README.md)

## English

The Web interface uses Chinese source strings as stable lookup keys and an English dictionary at `src/web/locales/en.json`. Call `uiText(key, values)` for application labels. Keep a complete sentence in one entry; use `{0}`, `{1}` for dynamic values so translations control word order and spacing. Never translate conversation content, uploaded files, model IDs, or values used in protocol requests.

`LanguageSelect` stores `uncensia.language` on the current browser and reloads the interface. The reload is required because some option lists are initialized at module load; the normal draft/reconnect path preserves chat drafts. Unsubmitted settings forms are not persisted. The first visit follows the browser’s language. Dates use the selected locale.

Native iOS uses `uncensiaText` and matching `Resources/en.lproj` / `Resources/zh-Hans.lproj/Localizable.strings`. App language selection is handled by iOS. Use `%@` placeholders for values passed to `uncensiaText`; do not translate those values. Dynamic provider text stays verbatim. XcodeGen includes Resources in the application target.

Run `npm run typecheck` and `npm run audit`. The localization audit checks literal Web keys, interpolation contracts, language switching, and native resource parity. Inspect real pages at desktop and phone widths in both languages. Native compilation and device tests must be run on macOS.

The paired project READMEs and this English user/developer guide cover the release. Detailed engineering contracts and dated historical evidence remain in their original language; keep those boundaries explicit when documenting coverage.

## 中文

Web 使用中文原文作为稳定索引，英文词典位于 `src/web/locales/en.json`。应用文案通过 `uiText(key, values)` 读取。完整句子放在一个条目中，用 `{0}`、`{1}` 传入动态内容，让译文决定语序和空格。不要翻译对话、上传文件、模型 ID 或协议请求值。

`LanguageSelect` 在当前浏览器保存 `uncensia.language`，然后重新加载界面。部分选项在模块加载时初始化，所以需要重新加载；常规草稿与重连路径会保留对话草稿。未提交的设置表单不持久化。首次打开跟随浏览器语言，日期使用所选语言格式。

原生 iOS 使用 `uncensiaText` 和一一对应的 `Resources/en.lproj`、`Resources/zh-Hans.lproj/Localizable.strings`，由 iOS 管理应用语言。传入 `uncensiaText` 的动态值使用 `%@` 占位，不翻译这些值。服务商返回文案保持原文。XcodeGen 将 Resources 加入应用目标。

执行 `npm run typecheck` 和 `npm run audit`。本地化检查覆盖 Web 字面量索引、插值、语言切换及原生资源一致性。还要检查两种语言下的桌面和手机页面；原生编译与设备测试需要 macOS。

两份项目 README 与英文使用/开发指南覆盖发布使用路径。详细技术契约和有日期的历史证据保留原文，说明双语覆盖时要明确这个范围。
