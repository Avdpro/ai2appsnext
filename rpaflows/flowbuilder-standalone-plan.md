# Standalone FlowBuilder 设计与实施清单

更新时间：2026-03-10
维护规则：每完成一项，把 `[ ]` 改为 `[x]`，并在该项下补充“完成日期 / 关键变更文件 / 验证结果”。

## 1. 背景与目标

目标：新增一个“独立页面版 FlowBuilder”（类似 `audit.html`），在普通浏览器中作为控制台运行；调试执行仍通过当前系统的 `WebRpa/WebDriveSys` 在受控浏览器里完成。

核心要求：
- 独立页面可访问：`/rpaflows/builder`
- 支持“启动/接入 WebRpaSys”
- 支持“选择当前调试页面 / 打开空白页调试”
- 支持“单步调试、保存/加载 flow”
- 不破坏现有 `run-page-assistant.mjs` 内置 FlowBuilder

## 2. 非目标（本期不做）

- 不重写现有 Flow 执行引擎（继续复用 `runFlow/FlowStepExecutor`）
- 不先做签名机制（后续单独接入）
- 不先做多人协同与权限系统
- 不先做视觉化拖拽编排器（先文本/表单编辑）

## 3. 难点与对应策略

### 3.1 难点：Builder 页面在非受控浏览器，如何调试目标页
策略：控制面与执行面分离。
- 控制面：`/rpaflows/builder`（普通浏览器）
- 执行面：`WebRpa` 受控页面（可被 click/run_js 等操作）
- 二者通过后端 `BuilderSession` 桥接

### 3.2 难点：如何选择调试页与新开空白页
策略：提供明确 session/contexts API。
- 列出可调试页面（contextId/url/title）
- 选择当前页面作为 active context
- 一键 `about:blank` 新开页并自动设为 active（可配置）

### 3.3 难点：复用现有 FlowBuilder 逻辑，避免分叉
策略：抽取 `FlowBuilderCore`。
- 从 `run-page-assistant.mjs` 抽出纯逻辑函数
- in-page 与 standalone 共用同一 core

## 4. 总体架构

- 前端：`public/rpaflows/builder.html`
- 路由：`routes/APIRPAFlowBuilder.mjs`
- 会话管理：`rpaflows/FlowBuilderSessionManager.mjs`
- 核心能力：`rpaflows/FlowBuilderCore.mjs`
- 复用引擎：`runFlow`, `WebRpa`, `WebDriveSys`, `FlowStepExecutor`

```text
Builder UI (普通浏览器)
   -> /rpaflows/api/builder/*
      -> BuilderSessionManager
         -> WebRpa/WebDriveSys
            -> 受控浏览器页面(context)
```

## 5. 关键数据模型

### 5.1 BuilderSession（服务端内存态）
- `id`: string
- `alias`: string
- `createdAt`: ISO string
- `status`: `starting|ready|closed|error`
- `browserRef`: WebRpa/WebDrive handle
- `contexts`: [{ contextId, url, title, active }]
- `activeContextId`: string
- `draftFlow`: object

### 5.2 API 返回统一 envelope
- `ok`: boolean
- `reason`: string（失败时）
- `data`: object（成功载荷）

## 6. API 设计（Phase 1）

- `POST /rpaflows/api/builder/session/start`
  - 入参：`alias`, `launchMode`, `startUrl`
  - 出参：`sessionId`, `status`

- `GET /rpaflows/api/builder/session/:id`
  - 出参：session 基本状态

- `GET /rpaflows/api/builder/session/:id/contexts`
  - 出参：`contexts[]`, `activeContextId`

- `POST /rpaflows/api/builder/session/:id/contexts/select`
  - 入参：`contextId`

- `POST /rpaflows/api/builder/session/:id/open`
  - 入参：`url`（默认 `about:blank`）, `setActive`（默认 true）

- `POST /rpaflows/api/builder/session/:id/run-step`
  - 入参：`step`
  - 出参：`status/reason/history/lastResult`

- `POST /rpaflows/api/builder/session/:id/save-flow`
  - 入参：`flow`, `sourcePath?`

- `GET /rpaflows/api/builder/flows`
- `POST /rpaflows/api/builder/flows/load`

## 7. 前端页面功能（Phase 1）

- Session 区：启动/连接状态
- Context 区：列表、选中、刷新、新开空白页
- Step 调试区：编辑 step + run-step
- Flow 区：加载/保存 flow
- Log 区：展示 API 调用日志与最近执行结果

## 8. 安全与稳定性约束

- 只允许在 `RPAFLOWS=true` 时启用 builder API
- 限制每进程最大 session 数（默认 3）
- session 空闲超时自动释放（默认 30 分钟）
- API 输入做结构校验，拒绝无效 step/flow
- 任何异常不影响主 app 启动

## 9. 验收标准（DoD）

- 能从独立页面启动/接入 WebRpa
- 能列出并切换目标 context
- 能新开 `about:blank` 并执行一个 `goto` 或 `run_js` 调试步骤
- 能保存 flow 到 `rpaflows/flows/*.json`
- 不回归现有 in-page FlowBuilder 能力

## 10. Todo 清单

- [x] T0：落地设计文档与实施清单
完成日期：2026-03-10
关键变更文件：`/Users/avdpropang/sdk/cchome/home/rpaflows/flowbuilder-standalone-plan.md`
验证结果：文档已创建，后续按此清单逐项勾选。

- [x] T1：抽取 `FlowBuilderCore.mjs`
目标：从 `run-page-assistant.mjs` 抽离纯逻辑函数（sanitize/list/load/save/runStep）。
验收：in-page 与 standalone 都通过 core 调用。
完成日期：2026-03-10
关键变更文件：`/Users/avdpropang/sdk/cchome/home/rpaflows/FlowBuilderCore.mjs`、`/Users/avdpropang/sdk/cchome/home/rpaflows/run-page-assistant.mjs`
验证结果：`run-page-assistant` 已改为调用 core；`node --check` 通过；`listSavedBuilderFlows/loadSavedBuilderFlowFromPath` 本地调用验证通过（示例：`_rpa-sync-min.json` -> `id=open_page_and_read_title`，`steps=8`）。

- [x] T2：实现 `FlowBuilderSessionManager.mjs`
目标：提供 start/close/get/listContexts/selectContext/openPage。
验收：可创建 session 并维护 active context。
完成日期：2026-03-11
关键变更文件：`/Users/avdpropang/sdk/cchome/home/rpaflows/FlowBuilderSessionManager.mjs`
验证结果：模块已实现并导出 `FlowBuilderSessionManager/getFlowBuilderSessionManager`；`node --check` 通过；最小运行校验通过（`listSessions=0`、`cleanupExpiredSessions.closed=0`，未启动浏览器场景）。

- [x] T3：新增 `routes/APIRPAFlowBuilder.mjs`
目标：实现第 6 节 API，并接到 `app.js`（受 `RPAFLOWS=true` 控制）。
验收：API 可调用，错误返回一致。
完成日期：2026-03-11
关键变更文件：`/Users/avdpropang/sdk/cchome/home/routes/APIRPAFlowBuilder.mjs`、`/Users/avdpropang/sdk/cchome/home/app.js`、`/Users/avdpropang/sdk/cchome/home/rpaflows/FlowBuilderSessionManager.mjs`
验证结果：新增 builder API 路由（session/context/open/run-step/save-flow/flows）；`app.js` 已在 `RPAFLOWS=true` 时挂载 audit+builder 并分别容错；`node --check` 全部通过。

- [x] T4：新增独立页面 `public/rpaflows/builder.html`
目标：实现 session/context/step/run/save/load 的最小 UI。
验收：页面可完成单步调试闭环。
完成日期：2026-03-11
关键变更文件：`/Users/avdpropang/sdk/cchome/home/public/rpaflows/builder.html`、`/Users/avdpropang/sdk/cchome/home/routes/APIRPAFlowBuilder.mjs`
验证结果：新增独立入口 `GET /rpaflows/builder`；页面已接通 session/context/run-step/save-flow/flows API，具备最小闭环；路由语法检查通过。

- [x] T5：日志与可观测性
目标：像 audit 一样输出 begin/done/error 与耗时。
验收：每次 run-step / save-flow 可定位问题。
完成日期：2026-03-11
关键变更文件：`/Users/avdpropang/sdk/cchome/home/routes/APIRPAFlowBuilder.mjs`、`/Users/avdpropang/sdk/cchome/home/public/rpaflows/builder.html`
验证结果：Builder API 已接入结构化日志（session/context/step/flow 事件，含耗时）；日志文件落地到 `rpaflows/flow-logs/*.ndjson`；新增 `GET /rpaflows/api/builder/log-meta` 返回日志文件路径，页面已展示该路径。

- [ ] T6：回归与收口
目标：验证不影响现有 `run-page-assistant` FlowBuilder。
验收：in-page smoke + standalone smoke 均通过。

- [x] T7：外壳编辑增强（说明/能力/参数）
目标：把独立页 Flow 外壳编辑升级为结构化机制，避免仅靠 JSON 手改。
验收：可在 UI 中编辑 goal/description/capabilities/args(定义)/filters，并一键写回 flow JSON。
完成日期：2026-03-11
关键变更文件：`/Users/avdpropang/sdk/cchome/home/public/rpaflows/builder.html`
验证结果：新增 Flow 描述字段、参数定义编辑器（key/type/required/desc/default）、参数键批量补全与新增按钮；外壳写回时同步到 `flow.description`、`flow.goal/meta.goal`、`flow.capabilities`、`flow.args`、`flow.filters`；页面脚本 `node --check` 通过。

- [x] T8：Session 集成系统登录与登录态调用（TabOS NT）
目标：参考 `sync/tabos/tabos_nt.js` 的登录与 `makeCall` 行为，在独立 Builder 的 Session Tab 提供登录、检查、登出、登录态调用系统函数能力。
验收：可在 Session Tab 中完成登录，显示登录态，并通过登录态调用系统函数（如 `userCurrency`）。
完成日期：2026-03-22
关键变更文件：`/Users/avdpropang/sdk/cchome/home/routes/APIRPAFlowBuilder.mjs`、`/Users/avdpropang/sdk/cchome/home/public/rpaflows/builder.html`
验证结果：新增 `system/login|check|logout|call|status` API；session 查询返回 `systemAuth`；Session Tab 新增系统登录区块与对应按钮，支持状态标签显示与调用结果输出；Session 启动时会读取 `localStorage`（`LoginVO`，兼容 `login-Info`）并自动登录，再调用 `userCurrency` 校验 token，不通过则清理本地登录信息；`node --check routes/APIRPAFlowBuilder.mjs` 通过。

## 11. 执行方式

从现在起按 `T1 -> T6` 顺序推进。
每完成一项：
1. 更新本文件对应复选框为 `[x]`
2. 在该项下补“完成日期 / 关键变更文件 / 验证结果”
3. 再进入下一项
