# RPA Flow TODO（未完成项）

更新时间：2026-02-19  
维护规则：每完成一项后将 `[ ]` 改为 `[x]`，并在该项下补充“完成日期/关键变更文件/验证结果”。

## 使用约定
- Flow 文件默认放在 `/Users/avdpropang/sdk/cchome/home/rpaflows/flows`
- 每个新 flow 至少配 1 个本地 smoke（优先 `test-pages`）和 1 个真实页面回归（如可执行）
- 缓存策略沿用当前规则系统（`rules/*.json`），能复用就复用，不额外发散格式
- 默认 `webRpa.currentPage` 为上下文来源；若传入 `page` 则兼容覆盖

## A. Read 家族缺失

- [x] `read.profile`（新建：`flows/read-profile-generic.js`）
实现目标：读取用户/频道资料（昵称、简介、关注/粉丝、认证信息、主页链接等）。
实现方式：优先 `run_js + query` 提取结构化 profile；失败时可降级 `run_ai` 摘要为结构化字段。
关键输入：`read.fields`、`read.requireFields`、`read.output`、可选 `read.target`。
验收标准：返回 `read.profile.result` 结构，`data` 为对象；`requireFields` 缺失时返回 `missingFields`。
测试计划：新增本地 profile 测试页 + 1 个真实社媒主页 smoke。
完成日期：2026-02-18
关键变更文件：`/Users/avdpropang/sdk/cchome/home/rpaflows/flows/read-profile-generic.js`、`/Users/avdpropang/sdk/cchome/home/rpaflows/flows/smoke-read-profile-local.json`、`/Users/avdpropang/sdk/cchome/home/rpaflows/test-pages/read/profile/index.html`、`/Users/avdpropang/sdk/cchome/home/rpaflows/test-pages/read/profile/profile.html`
验证结果：`smoke_read_profile_local_4` 通过（支持 `read.target.query` 先打开 profile，再返回 `name/bio/followers/following/verified/profileUrl/avatarUrl`，`missingFields=[]`）

- [x] `read.reactions`（新建：`flows/read-reactions-generic.js`）
实现目标：读取点赞/评论/收藏/转发等计数字段。
实现方式：`run_js + query` 识别计数区块并归一化（数字/简写数字如 1.2k）。
关键输入：`read.fields`、`read.requireFields`、`read.target`。
验收标准：返回 `read.reactions.result`，`data` 中包含请求字段；无法满足 `requireFields` 时明确失败原因。
测试计划：本地 reactions 测试页（静态+动态更新）+ 真实帖子页回归。
完成日期：2026-02-18
关键变更文件：`/Users/avdpropang/sdk/cchome/home/rpaflows/flows/read-reactions-generic.js`、`/Users/avdpropang/sdk/cchome/home/rpaflows/flows/smoke-read-reactions-local.json`、`/Users/avdpropang/sdk/cchome/home/rpaflows/test-pages/read/reactions/index.html`
验证结果：`smoke_read_reactions_local_3` 通过（输出 `likes=1200/comments=345/shares=87/favorites=56/views=98000`，`missingFields=[]`；流程包含规则抽取 + `run_js(query)` 代码生成与缓存 + 兜底机制）

- [x] `read.batch`（新建：`flows/read-batch-generic.js`）
实现目标：批量读取多个条目详情（通常先 list 再 detail）。
实现方式：支持两种入口：直接给 URL 列表，或先 invoke `read.list` 后按条目逐个 `interact.open/read.detail`；加入并发上限。
关键输入：`read.target`、`read.minItems`、`concurrency`、`read.fields`。
验收标准：返回 `read.batch.result.items`（每项含 `url + data/error`），整体不中断。
测试计划：本地列表详情页链路 smoke；真实网站小批量（3-5 条）回归。
完成日期：2026-02-18
关键变更文件：`/Users/avdpropang/sdk/cchome/home/rpaflows/flows/read-batch-generic.js`、`/Users/avdpropang/sdk/cchome/home/rpaflows/FlowStepExecutor.mjs`、`/Users/avdpropang/sdk/cchome/home/rpaflows/flows/smoke-read-batch-local.json`、`/Users/avdpropang/sdk/cchome/home/rpaflows/test-pages/read/batch/index.html`、`/Users/avdpropang/sdk/cchome/home/rpaflows/test-pages/read/batch/detail-1.html`、`/Users/avdpropang/sdk/cchome/home/rpaflows/test-pages/read/batch/detail-2.html`、`/Users/avdpropang/sdk/cchome/home/rpaflows/test-pages/read/batch/detail-3.html`
验证结果：`smoke_read_batch_local_1` 通过（3 条详情并发读取成功，`items.length=3`、`okCount=3`，日志见 `/Users/avdpropang/sdk/cchome/home/rpaflows/flow-logs/smoke_read_batch_local_smoke_read_batch_local_1.ndjson`）
补充进展（2026-02-18）：
- 已将实现从专用 `readBatch` action 重构为通用 `invokeMany + invoke.fork`。
- 最新验证：`smoke_read_batch_local_4` 通过（统一 `invokeMany` 返回结构后回归通过）。

## B. Compose/内容管理缺失

- [ ] `compose.edit`（新建：`flows/compose-edit.js`）
实现目标：编辑已发布内容或已有草稿（按 `compose.parent` 定位）。
实现方式：先定位目标内容 -> 进入编辑态 -> 复用 `compose.input/file` 子流程 -> 可选发布保存。
关键输入：`compose.parent`（必需）、`compose.field/text/blocks/files/visibility`。
验收标准：返回 `compose.result`，包含 `action=edit`，失败时指出卡点步骤。
测试计划：本地“帖子列表+编辑页”测试站点 + 真实站点人工确认 smoke。

- [ ] `delete.post`（新建：`flows/delete-post.js`）
实现目标：删除指定 post。
实现方式：双重保护：先定位目标，再确认删除控件，再进行二次确认（可 assist）；支持 strict 模式。
关键输入：建议新增 `delete.target`（或复用 `read.target`）用于精确定位。
验收标准：返回 `delete.post.result.deleted=true/false`，并给出证据（目标消失或状态变化）。
测试计划：本地可恢复删除测试页（软删除）+ 真实站点仅手工演示不默认执行。

## C. 导航/下载/展开缺失

- [x] `nav`（新建：`flows/nav-generic.js`）
实现目标：根据 `nav.dest` 进行站内导航（home/account/inbox/settings 等）。
实现方式：`query -> selector` 缓存导航入口，失败回退 assist；成功后校验 URL/标题/区域特征。
关键输入：`nav.dest`。
验收标准：返回 `nav.result.dest/url`，导航失败可诊断。
测试计划：本地多入口导航测试页 + 1 个真实网站回归。
完成日期：2026-02-18
关键变更文件：`/Users/avdpropang/sdk/cchome/home/rpaflows/flows/nav-generic.js`、`/Users/avdpropang/sdk/cchome/home/rpaflows/flows/smoke-nav-local.json`、`/Users/avdpropang/sdk/cchome/home/rpaflows/test-pages/nav/index.html`、`/Users/avdpropang/sdk/cchome/home/rpaflows/test-pages/nav/inbox.html`、`/Users/avdpropang/sdk/cchome/home/rpaflows/test-pages/nav/settings.html`
验证结果：`smoke_nav_local_20260218_1` 通过（`nav.dest=inbox`，实际跳转到 `/nav/inbox.html`，无 assist）

- [x] `download`（新建：`flows/download-file.js`）
实现目标：支持点击下载和直链下载两种模式。
实现方式：优先 `download.url`，否则按 `download.target` 点击触发；监听下载事件并记录保存结果。
关键输入：`download.action=file`、`download.url|download.target`、`download.saveAs`、`download.multi`。
验收标准：成功时返回下载文件信息（建议后续补 `download.result` 结构化字段）。
测试计划：本地可下载测试页（单文件/多文件）+ 实网文件链接 smoke。
完成日期：2026-02-18
关键变更文件：`/Users/avdpropang/sdk/cchome/home/rpaflows/flows/download-file.js`、`/Users/avdpropang/sdk/cchome/home/rpaflows/flows/smoke-download-local.json`、`/Users/avdpropang/sdk/cchome/home/rpaflows/FlowStepExecutor.mjs`、`/Users/avdpropang/sdk/cchome/home/rpaflows/WebDriveContext.mjs`、`/Users/avdpropang/sdk/cchome/home/rpaflows/WebDriveSys.mjs`、`/Users/avdpropang/sdk/cchome/home/rpaflows/WebDriveRpa.mjs`
验证结果：`smoke_download_local_20260218_1` 通过（`started=true`、`finished=true`、`filepath=/Users/avdpropang/Downloads/sample(5).txt`）

- [x] `showMore`（新建：`flows/show-more-generic.js`）
实现目标：统一“展开更多内容/更多评论/更多描述”。
实现方式：先尝试按钮点击型，再尝试滚动触发型；可复用 `loadMore` 的一部分检测逻辑。
关键输入：可选目标（建议支持 `showMore.target`，若不扩展则用当前主内容）。
验收标准：返回 `showMore.result.expanded/newItems`。
测试计划：本地折叠文本+评论展开测试页。
完成日期：2026-02-18
关键变更文件：`/Users/avdpropang/sdk/cchome/home/rpaflows/flows/show-more-generic.js`、`/Users/avdpropang/sdk/cchome/home/rpaflows/flows/smoke-showmore-local.json`、`/Users/avdpropang/sdk/cchome/home/rpaflows/flows/smoke-showmore-checkonly-local.json`、`/Users/avdpropang/sdk/cchome/home/rpaflows/test-pages/showmore/collapsed.html`、`/Users/avdpropang/sdk/cchome/home/rpaflows/test-pages/showmore/expanded.html`
验证结果：`smoke_showmore_local_20260218_1` 通过（折叠页成功展开）；`smoke_showmore_checkonly_local_20260218_2` 通过（仅检测路径正确返回 blocked=false）

## D. AI 能力 flow（占位到可用）

- [x] `ai.extract`（新建：`flows/ai-extract-generic.js`）
实现目标：对页面清洗 HTML 做结构化抽取。
实现方式：统一先读清洗 HTML（`readInnerHTML removeHidden=true`），再调用 AI 抽取并验证字段。
关键输入：`ai.extract`（可扩展规则对象）+ 字段 schema。
验收标准：返回 `ai.extract.result.data`；具备失败重试和验证日志。
测试计划：本地复杂 DOM 页 + 真实文章页抽取 smoke。
完成日期：2026-02-19
关键变更文件：`/Users/avdpropang/sdk/cchome/home/rpaflows/flows/ai-extract-generic.js`、`/Users/avdpropang/sdk/cchome/home/rpaflows/flows/smoke-ai-extract-local.json`
验证结果：`smoke_ai_extract_local_1` 通过（提取 `title/summary/author`，`missingFields=[]`）；日志：`/Users/avdpropang/sdk/cchome/home/rpaflows/flow-logs/smoke_ai_extract_local_smoke_ai_extract_local_1.ndjson`

## E. Browser 能力 flow（能力对齐）

- [ ] `browser.headless`（新建：`flows/browser-headless-cap.js`）
实现目标：可被 invoke 检测/设置 headless 能力（先最小占位）。
实现方式：先返回 `supported`；后续再接实际运行态切换。
验收标准：返回 `browser.headless.result.supported=true`。
测试计划：invoke smoke。

- [ ] `browser.devtools`（新建：`flows/browser-devtools-cap.js`）
实现目标：可被 invoke 检测/设置 devtools 能力（先占位）。
实现方式：同上。
验收标准：返回 `browser.devtools.result.supported=true`。
测试计划：invoke smoke。

- [ ] `browser.profile`（新建：`flows/browser-profile-cap.js`）
实现目标：可检测 profile 隔离能力并返回当前 profile 信息（若可取）。
实现方式：读取当前启动参数和 profile dir；先完成只读能力。
验收标准：返回 `supported`，可选返回当前 profile 标识。
测试计划：两组 profile 启动回归。

- [ ] `browser.cookies`（新建：`flows/browser-cookies-cap.js`）
实现目标：cookie 能力占位 + 最小读写能力（按安全策略）。
实现方式：先做 capability 检测；后续再细化 set/get/import/export。
验收标准：返回 `supported`，并明确安全限制。
测试计划：本地 cookie 读写 smoke。

## F. WebChat 能力（分阶段）

- [x] `webChat` Phase 1（新建：`flows/webchat-core.js`）
实现目标：先支持 `getSessions/enterSession/getMessages/send` 四个 action。
实现方式：沿用 query+cache+assist 模式；会话定位支持 `session.pick`。
关键输入：`webChat.action`、`webChat.session`、`webChat.text`、`webChat.limit`。
验收标准：返回 `webChat.result`，消息结构至少包含 `id/role/text/time/status/index`（best-effort）。
完成进展（2026-02-19）：
- 已完成：`newSession/send/getMessages/waitReply/getSessions/enterSession`
- 已新增：`renameSession/deleteSession` 基础版（hover/more + assist 降级）
- 已通过本地 smoke：`smoke-webchat-newsession-local.json`、`smoke-webchat-send-local.json`、`smoke-webchat-getmessages-local.json`、`smoke-webchat-waitreply-local.json`、`smoke-webchat-getsessions-local.json`、`smoke-webchat-entersession-local.json`
补充进展（2026-02-19）：
- 已新增站点适配层：`/Users/avdpropang/sdk/cchome/home/rpaflows/site-profiles/webchat-profiles.mjs`，`webchat-core` 启动时按 `origin/host` 合并 selectors/menuMode（默认 + 站点）。
- 修复 selector 模板兼容问题：去除 step `by` 中的 `||` 表达式，改为 profile 预填默认 selector，避免出现空 `css:`。
- 修复 `enterSession` 目标解析：拆分 `sessionItem`（列表枚举）与 `sessionItemByIdTemplate`（按 id 定位），避免伪 id（如 `session_12`）导致点击失败。
- 修复 `getMessages` smoke 稳定性：`/Users/avdpropang/sdk/cchome/home/rpaflows/flows/smoke-webchat-getmessages-local.json` 增加 `waitReply` 步骤，避免 mock 异步回复窗口导致误报。
- 最新验证：`smoke_webchat_getmessages_local_profile_4`、`smoke_webchat_getsessions_local_profile_3`、`smoke_webchat_entersession_local_profile_4` 均通过。

- [ ] `webChat` Phase 2（扩展到其余 action）
实现目标：补齐 `loadMoreMessages/searchMessages/addAsset/input/react/markRead`，并将 `renameSession/deleteSession` 升级为站点级强鲁棒（含 hover/right-click/context-menu）。
实现方式：在 Phase 1 基础上增量实现，不重写核心框架。
验收标准：action 路由完整，参数校验按 `rpa.mjs` 执行。
测试计划：每个 action 至少一个 smoke。

## G. 质量与回归基线

- [ ] 新增统一“能力覆盖看板”脚本（建议：`run-cap-coverage.mjs`）
目标：自动比较 `rpa.mjs` caps 与 flow registry，输出已实现/缺失清单。

- [ ] 新增 smoke 套件分组执行（read/compose/interact/nav/webchat）
目标：减少回归成本，支持快速定位破坏性变更。

- [ ] 文档同步更新
目标：每完成一项 flow，更新 `rpa-flow-spec-v*.md` 与示例 args，保证“spec/实现/测试”一致。

- [x] 新增 PromptBuilder（v0.55）并建立版本同步约束
目标：统一“原子动作决策”与“find-until 决策”提示词生成入口，避免各处硬编码 prompt 漂移。
关键变更文件：`/Users/avdpropang/sdk/cchome/home/rpaflows/FlowPromptBuilder.mjs`
维护约束：spec 升级时必须同步更新 `FlowPromptBuilder.mjs` 中的 `FLOW_PROMPT_SPEC_VERSION` 与 Action Union 定义。
补充进展（2026-02-19）：
- 已强化 by 规范提示：若提供 `by`，必须是 `css:`/`xpath:` 前缀；禁止输出 `css/xpath/text` 裸值。

- [x] `find.until` 交互稳定性修复（cookie + by 规范 + click 校验 + scroll 支持）
目标：降低 find.until 在真实站点上的误点击与假成功，确保可复现定位问题。
关键变更文件：`/Users/avdpropang/sdk/cchome/home/rpaflows/flows/find-until-generic.js`、`/Users/avdpropang/sdk/cchome/home/rpaflows/FlowStepExecutor.mjs`、`/Users/avdpropang/sdk/cchome/home/rpaflows/FlowPromptBuilder.mjs`
完成日期：2026-02-19
验证结果：`find_until_omega_thickness_user_test_3` 通过，成功读取 Omega 厚度 `13.80 毫米`；日志：`/Users/avdpropang/sdk/cchome/home/rpaflows/flow-logs/find_until_generic_find_until_omega_thickness_user_test_3.ndjson`

## H. 引擎能力演进（已完成）

- [x] `invoke.fork` 三态支持（`false | true | string(url)`）
实现目标：在不破坏现有 invoke 行为前提下，支持子 flow 在隔离上下文执行。
实现方式：`FlowInvoke` 增加 `fork/forkWait`；`WebDriveRpa.fork/disposeFork` 支持“借用当前页且不关闭”模式。
关键变更文件：`/Users/avdpropang/sdk/cchome/home/rpaflows/FlowInvoke.mjs`、`/Users/avdpropang/sdk/cchome/home/rpaflows/WebDriveRpa.mjs`
验证结果：`smoke_invoke_fork_local_2` 通过（`fork=url` 与 `fork=true` 均符合预期）。

- [x] 通用 `invokeMany` action
实现目标：以通用机制替代专用批处理 action，支持动态 items + 并发 + 每项模板参数 + 每项 fork。
实现方式：`FlowStepExecutor` 新增 `invokeMany`；每项内部复用 `invoke` 执行并聚合结果。
关键变更文件：`/Users/avdpropang/sdk/cchome/home/rpaflows/FlowStepExecutor.mjs`
验证结果：`smoke_read_batch_local_4` 通过；`read.batch` 已切到 `invokeMany` 路径。

- [x] 统一 `invokeMany` 返回结构
实现目标：稳定输出，方便 flow/AI 编排消费。
输出约定：每项固定 `{index,item,ok,status,reason,value,error,invoke{flowId,status,reason}}`。
关键变更文件：`/Users/avdpropang/sdk/cchome/home/rpaflows/FlowStepExecutor.mjs`、`/Users/avdpropang/sdk/cchome/home/rpaflows/flows/read-batch-generic.js`
验证结果：`smoke_read_batch_local_4` 通过。

- [x] Spec 升级到 v0.55（并移除 v0.52 文件）
实现目标：文档与实现对齐，明确 `invoke.fork/invokeMany` 语义与返回结构。
关键变更文件：`/Users/avdpropang/sdk/cchome/home/rpaflows/rpa-flow-spec-v0.55.md`
清理：已删除 `/Users/avdpropang/sdk/cchome/home/rpaflows/rpa-flow-spec-v0.52.md`
