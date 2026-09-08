# 社区 skills：来源、采用边界与验证

## 2026-09-07 晚：官方 prompting 正文与工具说明

对照刚抓取的上游原文，只改编方法，不导入 CLI、JSON 提示词包或 SkillHub 上依赖 inference.sh 的条目：

| 位置 | 采用 |
| --- | --- |
| `skills/image-generate/references/community-craft.md` | 补入 pinned 提交里 [prompting.md](https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.system/imagegen/references/prompting.md) 的具体程度、允许/禁止扩写、参考图角色、单次迭代；生成/编辑判定采用同仓库 imagegen 的决策树。SkillAtlas 只取正向描述与参考职责，不取 OpenRouter/minibanana。 |
| `skills/image-generate/SKILL.md` | 用上述决策树写清「默认当新图，除非明确要改已有图」；参考图可以只指导描述。 |
| `tools/descriptions.ts` | 搜索 query 按 [OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling) / [Anthropic Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) 写成短用途说明，去掉 LibreChat 的运算符清单。记忆工具说明与「用户明确要求才写」对齐。引用锚点格式未改。 |

未改 `ORIGINAL_WRITING_PROMPT`，也未加长全局/工具 system。新正文需另跑真实模型轨迹；本页不是效果证明。

## 2026-09-07 补充：GitHub、SkillHub 与 Reddit

覆盖 system/tool prompt 及当前九个 skills，区分「来源方法」「Uncensia 适配」与「真实效果」：

| 层或 skill | 来源与采用 |
| --- | --- |
| system / tool prompt | 采用下节 OpenAI、Anthropic、Pi 的职责分离、明确工具边界、按需加载。稳定通用身份与执行契约常驻，创作步骤按需读。本次补充不改原 writing brief 或用户 global prompt，也不因找到更多模板而加长 system。 |
| image-generate / image-edit | [OpenAI imagegen](https://github.com/openai/skills/blob/main/skills/.system/imagegen/SKILL.md) 的具体需求少扩写、输出检查；[SkillAtlas](https://github.com/skillatlas/skills/blob/main/skills/image-generation-enhanced/SKILL.md) 的必需与可选细节分离。补充约束冲突检查及按实际观察描述编辑保真。 |
| image-compose / image-style | 同一组图像来源中的参考图职责、内容与风格分离；已有实现保持。精确图片 ID 和参数仍按 Uncensia 工具契约。 |
| image-series | 沿用图像 craft 及自身 references/series-community.md；槽位、数量、恢复依据来自本机轨迹。没有把社区单图经验当作百图可靠性证明。 |
| fiction-writing / roleplay | 沿用 NovelAI、DreamGen、SillyTavern 来源；补充 [SillyTavern Summarize](https://docs.sillytavern.app/extensions/summarize/) 和 [MemoryBooks](https://github.com/aikohanasaki/SillyTavern-MemoryBooks/blob/main/Start_Here.md) 的摘要/存储区分。小说 skill 的续写点区分已发生事件与未来计划，已有 RP 控制权和知识边界保持。 |
| video | [Runway Image to Video](https://help.runwayml.com/hc/en-us/articles/48324313115155-Image-to-Video-Prompting-Guide) 为已有的「首帧提供外观，文字描述运动」补充出处；不复制其模型参数。 |
| improve-uncensia | Pi 的普通技能机制，加上本项目产品约束和包资源所有权。它是 Uncensia 运维适配，不冒称来自某个社区 AIGC skill。 |

[SkillHub Design 目录](https://www.skillhub.club/skills?category=design&sort=popular&view=grid) 用于发现：其中 inference-sh 图像 skill 明确依赖 inference.sh CLI，不能直接替换 Uncensia 的工具和后端。目录可读，但本次对应详情链接抓取失败；不声称审计了该包，也未安装。聚合目录上的评分不是本机验收。

[Reddit 长 RP 讨论](https://www.reddit.com/r/SillyTavernAI/comments/1uoc7o5/long_context_high_consistency_rps/) 提供了摘要、场景笔记和记忆的实际使用线索。楼内的上下文长度与成功率说法属于个人经验，不采纳为模型通用阈值。Uncensia 此次仅改善续写交接指导，未实现 MemoryBooks，也没有新增自动记忆写入或每轮额外模型调用。

本次两处图像改动针对本机五轮实跑中已观察到的年龄偏差与过度保真声明。来源方法采用原创转述，未导入新上游脚本、完整 prompt 包或绕过安全限制的预设。适用的既有许可证及固定提交记录保留。新增文字需另行真实模型复测，之前五轮结果不作为新文字的效果证明；包源更新与运行中的 data/skills 同步是不同状态。

## 2026-09-07：工具选择与多轮约束修订

本次继续核对官方指导及社区项目，采用方法而非导入整套提示词：

| 来源 | 采用到 Uncensia 的具体位置 |
| --- | --- |
| [OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling) | 工具说明清楚区分用途与限制，精确资源 ID 由应用提供，不让模型从文件名猜测；`tools/generation.ts`、`prompts/context.ts`、`tools/file-search.ts` |
| [Anthropic Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) 与 [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) | 描述何时用/不用工具，少量有区分度的例子；生成 skill 说明“独立重生后继续优化”与“保留选定人物换场景”的差别，例子不作关键词路由 |
| [Pi skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md) 与 [pi-skills](https://github.com/badlogic/pi-skills) | 保持目录摘要和按需加载；system 只放通用目标、依赖、资源、结果契约，创作方法留在原有 skill 和引用文件，不另建执行循环 |
| [SillyTavern Character Design](https://docs.sillytavern.app/usage/core-concepts/characterdesign/) | 继续区分稳定人物资料、场景和示例；已有 RP skill 保留这套结构，不因本次修订再添加专门的导演提示 |

原有 writing brief 未改，自定义资源仍遵循包资源哈希所有权机制。没有承诺修改 prompt 就能消除提供方内容限制。模型文本答复、提供方明确错误、连接中断分别判断，不把无输出自动解释为拒绝。

修订还移除每轮仅一次搜索的限制与 country 失败后静默放宽范围的实现，纠正附件说明中“一律不要检索”与“截断时检索”的冲突。模型先读取已经提供的正文，需要未提供部分时按 ID 搜索；片段不是完整章节。

中性多轮夹具为 `scripts/fixtures/product-history.json` 的 `operation-continuity`：独立生成 → 继续优化 → 编辑第一版 → 只检查 → 普通问题。它检查实际工具、操作、资源、像素和副作用，不要求固定 skill 调用顺序。实跑证据与未达标项保存在本机 `run/prompt-improvement-20260907/`；自动检查不代表真实内容验收。

以下内容保留其原核对日期；其测试范围与结论不自动提升为本次通过。

核对日期：2026-09-06。依据当前源码、随仓库保存的来源记录和本机真实运行结果；本页记录来源、已实施修订和验证边界。

## 来源与采用

| 项目 | 来源与版本 | 实际采用 | 不代表什么 |
| --- | --- | --- | --- |
| 图像 craft | [OpenAI imagegen](https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.system/imagegen/SKILL.md)，固定提交 `49f948faa9258a0c61caceaf225e179651397431`；本地 [来源记录](../skills/image-generate/references/UPSTREAM.json) 与 [Apache-2.0 许可证](../skills/image-generate/references/LICENSE.txt) | 已改编的 [community-craft](../skills/image-generate/references/community-craft.md)：简洁构图、参考图职责、编辑不变量；执行改用 Uncensia 工具 | 不导入上游 CLI、宿主路径或默认后端；不能把所有 Uncensia skill 都标为 OpenAI 原作 |
| RP 写作方法 | SillyTavern 官方 [Character Design](https://docs.sillytavern.app/usage/core-concepts/characterdesign/)、[World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/) 与 [Character Card V2 主规格](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)；来源见 [RP reference](../skills/roleplay/references/community-methods.md) | Uncensia 原创转述：角色、场景、示例对白分离；按相关性使用设定。用户自主权、OOC、选项一致性是本地写作指导 | **没有完整 CCv2 导入器，也没有 ST World Info 引擎**；未采用卡片覆盖 system prompt、关键词递归注入或第三方 jailbreak 包；来源链接不转授上游许可 |
| Pi skill 机制 | 实装 `@earendil-works/pi-coding-agent` **0.85.1**，版本见 [package.json](../package.json) | 复用 SDK discovery、目录格式、原生 `read`、`/skill:name` 展开与解析；Uncensia 依 `contexts` 附加 RP/视觉状态，已读正文在相关多轮任务中保留，压缩时省略可重新读取的程序正文 | 这是机制复用；动态上下文适配是 Uncensia 代码，不是另一套语义路由器。SDK 能发现 skill 不等于导入任意产品的数据格式 |
| 图像序列 | Uncensia 原创 [image-series](../skills/image-series/SKILL.md)，复用上述 craft；[评估参考](../skills/image-series/references/series-community.md) | 用户指定操作优先、有限总数、逐槽位成功证据与恢复检查点 | 没有持久化 series 实体、无限续跑承诺或 20/50/100 幕可靠性证明 |

当前 [loop](../src/server/agent/loop.ts) 已保留 SDK discovery，并在加载后交给 [Runtime](../src/server/agent/runtime.ts) 补全 skill 元数据及有界读取。`disableModelInvocation` 保留在资源目录供显式命令使用，由 SDK 目录格式化隐藏；原生读取及显式展开的上下文接入、历史快照保留和压缩输入处理已出现在当前代码中。此项是源码核对，不等于线上进程已更新。`/skill:name` 是命令语法识别，任务该选哪个 skill 仍由模型判断。

## 描述与路由审阅

2026-09-06 后续实现增加了 CCv2 JSON **文本设定提取**：Web 本地预览名称、描述、
性格、场景和示例，用户应用草稿并保存后才进入对话。作者说明单独展示；世界书、
额外指令、开场白和扩展明确列为未应用。原始卡片不改写。此适配遵循字段含义，
没有实现规格要求的全部运行行为，因此仍不宣称完整 CCv2 兼容。
`rp-card-image-result.json` 验证了网页保存后的真实 RP + 本地生图链路；黑短发、
绿色外套和钟表铺的图像人工检查通过，示例中的蓝宝石未进入画面。
而旧错误选项驱动的剧情连续性，三次分支复测仍失败，角色卡接入不能作为其修复证明。

该轮审阅覆盖随仓库分发的 skills 及视觉上下文提示。以下记录保留当时修订；部署和新一轮真实行为验证另计。

| 位置 | 最终状态 |
| --- | --- |
| [image-generate](../skills/image-generate/SKILL.md) 与 [视觉上下文](../src/server/prompts/context.ts) | 显式操作、模型、参考排除和范围优先；独立重生保持生成，纯提示词不调用媒体工具；未指定操作时才按目标判断 |
| [image-style](../skills/image-style/SKILL.md) | 明确分析/提示词、风格编辑、新图三个分支；参考图不自动触发编辑；无像素时不声称视觉验证 |
| [video](../skills/video/SKILL.md) | 保留指定片数、顺序和文生/图生操作；按成功资产计数；移除任意单条上限和首帧额外确认，不擅自缩减时长或新增变体 |
| [improve-uncensia](../skills/improve-uncensia/SKILL.md) | 限定为 Uncensia 持续行为/配置/源码修改；采用原生 read/显式命令描述；通过当前允许的工具运行真实检查，无法运行则标 NOT RUN；不增加确认步骤 |
| [image-edit](../skills/image-edit/SKILL.md)、[image-compose](../skills/image-compose/SKILL.md)、image-style、video | 明确用户操作/模型/范围优先；提示词语言按用户显式要求，否则按后端说明；图内文字保持原文，能力冲突明确报告；合成不再将每个参考限制为一个贡献 |

### 修订验证与 lab 复测输入

此前 skill 审计 20 项、prompt 审计 8 项和 typecheck 均通过；新增独立示例与角色卡文本适配检查后 skill 审计为 22 项。没有把词句匹配增加为“语义路由测试”。以下行为夹具检查实际工具调用/参数/结果，不限制模型必须采用某个 skill 调用序列；实际运行证据另见验收报告：

| 输入夹具 | 核对结果 |
| --- | --- |
| 附风格图：“只分析光线和色调，写提示词，不生成” | 可读取图片；零生成/编辑 job |
| 有人物参考：“用指定生图模型独立重生两张，不编辑” | 两个生成槽位，使用指定模型，无编辑替换；能力不足时说明而不换模型 |
| “编辑这张海报，英文描述修改要求，保留中文标题‘雨巷书店’” | 编辑操作、精确源 ID；渲染文字不翻译，英文要求不传播到标题 |
| “按顺序文生三个视频，不用参考图、不先做首帧” | 三个已授权槽位；没有图生替换、首帧调用、每段确认或任意单条截断；失败按实际状态报告 |
| “只把这次图片改亮” / “修改 Uncensia 的默认图像 skill 并检查” | 前者只处理当前图片；后者才修改持续行为，并提供真实工具检查结果或明确 NOT RUN |

上述新夹具尚未实跑，不能用下方修订前的三幕记录替代。
image-edit 的单图改动、image-compose 的多图内容贡献、image-series 的连续状态、roleplay 的互动叙事边界总体可区分；需要组合时加载多个 skill，不应以“只能加载某一个”的断言评价路由。

## 真实三幕结果

本机证据位置：`run/history-live-20260906/10-series-result.json`、`run/history-live-20260906/11-series-complete-result.json`（相对 `uncensia/`）。这些运行产物不随仓库分发。

| 槽位 | 实际资产 | 证据 |
| --- | --- | --- |
| 1：到达旧书店 | `img_6145f265dcc0be70f184913e53731cc8` | 用户指定复用的已有参考图，不计为本次新生成 |
| 2：橱窗前读纸条 | `img_41d99871aca2baf6ac0a1333c7defc20` | `job_d16ed5015c4d40719ab7d823091afade`，`succeeded` |
| 3：走向钟表铺 | `img_d0d2c7d79c48868aa3821a74320d0d69` | `job_82c28c67a1ea480ab7900b932a2747d8`，`succeeded` |

两次新生成均为 `text_to_image`、`comfy:lustify-v10`、空 sources，没有切换编辑。后续“继续全部”查看了三个准确 ID，没有新增生成调用；两份结果中的 job ID 集合相同，不能重复计数。实际边界为 **3 个槽位＝1 张复用＋2 张新图**，没有第四幕。

运行回复报告了纸条数量、回望方向和招牌文字偏差；本页只核对结果记录，不把这些回复视为独立像素验收。已证明的本次操作/数量边界不等于长期序列稳定性，也不证明中断恢复或所有历史失败场景均已通过。
