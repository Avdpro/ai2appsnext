# Flow 系统审核机制设计与 Todo

> 目标：基于现有 `public/rpaflows/audit.html` 与云端 Flow 管理 API，做一套“开发者提交 -> 系统审核 -> 系统发布”的闭环机制。

## 1. 当前基础（已具备）

- 开发者提交：`saveFlowDraft(status=SUBMITTED)`。
- 开发者发布申请：`requestPublishFlow`（已实现），会检查当前云端版本是否有 `authorSignature`，并把状态标记为 `PENDING_PUBLISH_APPROVAL`。
- 系统正式发布：`publishFlow`（需要 `systemSignature`）。
- 审计能力：`/rpaflows/api/audit`（支持 policy + AI 审计）。
- 审计页面：`public/rpaflows/audit.html`（单 Flow 审计 UI）。

## 2. 审核机制目标流程（建议）

1. 开发者在 Builder 提交 `SUBMITTED`。
2. 开发者点击“发布Flow”后，状态变为 `PENDING_PUBLISH_APPROVAL`。
3. 审核员在“系统审核页”拉取待审核 Flow 列表。
4. 审核员执行预审计（复用 audit 逻辑），可查看风险、AI 审计结论、签名信息。
5. 审核员给出结论：
- `APPROVED`：允许进入系统发布。
- `REJECTED`：退回开发者。
6. 审核员（或系统发布员）使用系统私钥签名并调用 `publishFlow` 完成系统发布（状态 `PUBLISHED`）。

## 3. 数据与状态约定

- `status` 建议使用：
- `DRAFT`
- `SUBMITTED`
- `PENDING_PUBLISH_APPROVAL`
- `APPROVED`
- `REJECTED`
- `PUBLISHED`
- `UNPUBLISHED`

- 新增/规范字段（Mongo 文档）：
- `publishRequest`: `{ requestedAt, requestedBy, version, note }`
- `review`: `{ reviewedAt, reviewedBy, decision, note, auditDigest, auditSummary }`
- `systemSignature`: 系统签名对象（发布时写入）

## 4. API 设计（建议增量）

### 4.1 审核列表与详情
- [ ] `listPendingPublishFlows`
  - 输入：`userId/token`, `limit`, `skip`
  - 输出：`status in [SUBMITTED, PENDING_PUBLISH_APPROVAL]` 的列表（默认仅本人或审核员可见策略待定）

- [ ] `getFlowReviewDetail`
  - 输入：`userId/token`, `ownerUserId`, `flowId`
  - 输出：flow summary + content + signatures + publishRequest + review

### 4.2 审核动作
- [ ] `reviewFlow`
  - 输入：`userId/token`, `ownerUserId`, `flowId`, `decision(approve|reject)`, `note`, `auditSummary`
  - 行为：
    - `approve` -> `status=APPROVED`
    - `reject` -> `status=REJECTED`
  - 写入 `review` 字段。

### 4.3 系统发布动作
- [ ] `publishApprovedFlow`
  - 输入：`userId/token`, `ownerUserId`, `flowId`, `systemSignature`, `reviewComment`, `channel`
  - 前置检查：`status=APPROVED` 且 `authorSignature` 合法。
  - 行为：写入 `systemSignature` + `published` + `status=PUBLISHED`。

## 5. 页面设计（基于 audit.html）

建议新增：`public/rpaflows/review.html`

页面分三块：
- 左：待审核列表（FlowId/Owner/Version/Status/更新时间）。
- 中：Flow 内容 + 审计参数 + 审计执行（复用 audit 页面交互）。
- 右：签名与审核操作（签名状态、审核备注、批准/驳回、系统发布）。

关键交互：
- [ ] 列表选中后自动加载该 Flow 云端内容。
- [ ] 一键“执行预审计”（调用 `/rpaflows/api/audit`，flowText 来自云端 content）。
- [ ] 显示签名状态：
  - 开发者签名是否存在
  - 系统签名是否存在
- [ ] 审核按钮：批准 / 驳回。
- [ ] 发布按钮：选择系统私钥后发布（仅审核通过可点）。

## 6. 安全与权限

- [ ] 增加审核员权限检查（例如 rank >= ADMIN，或白名单账号）。
- [ ] `reviewFlow/publishApprovedFlow` 必须仅审核员可调用。
- [ ] 对 `systemSignature` 做服务端验签（后续可接入用户公钥或系统公钥配置）。
- [ ] 审核与发布行为写审计日志（who/when/what）。

## 7. 实施 Todo（按顺序）

### T1: API 最小闭环
- [x] 增加 `listPendingPublishFlows`
- [x] 增加 `getFlowReviewDetail`
- [x] 增加 `reviewFlow`
- [x] 增加 `publishApprovedFlow`（内部可先复用 `publishFlow` 逻辑）

### T2: Review 页面骨架
- [x] 新建 `review.html`（复用 audit 页样式和运行逻辑）
- [x] 接入待审核列表 + 详情加载
- [x] 接入预审计执行与结果展示

### T3: 审核动作与发布动作
- [x] 接入 批准/驳回
- [x] 接入 系统私钥选择 + 发布
- [x] 完成状态联动（按钮可用性随状态变化）

### T4: 权限与验签
- [x] 接入审核员权限门禁
- [x] 服务端验签校验与失败原因输出
- [x] 行为日志完善

### T5: Builder 联动优化
- [ ] 在 Builder Publish 区增加“查看审核进度”跳转
- [ ] 展示最近审核状态与审核意见

## 8. 兼容策略

- 不破坏现有开发者提交链路：
- `提交到云端` 保持 `saveFlowDraft(status=SUBMITTED)`。
- `发布Flow` 保持 `requestPublishFlow`。
- 系统审核/发布逻辑放新页面与新 API 中完成。

---

如果这个设计方向 OK，下一步建议直接开始 **T1**（API 最小闭环）。
