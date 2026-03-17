# Flow 管理/操作/调用规范（v0.1）

最后更新：2026-03-15  
适用范围：`flow`（本阶段不含 query cache）

## 1. 目标与范围

本规范用于统一服务器端 Flow 的管理、操作、调用机制，作为后续开发与联调基线。

本阶段目标：
- 使用现有对客统一 API 机制（`/ws` + `msg/vo`）。
- 在 MongoDB 中存储 Flow（仅存每个用户每个 flowId 的最新版本）。
- 支持作者签名 + 系统签名双签名。
- 支持按 `find` 规则查找并返回可下载 Flow。

明确不做：
- 不引入对象存储。
- 不存 `contentCanonical`。
- 不引入 query cache 管理（后续阶段）。

## 2. 统一 API 机制

必须遵循项目现有对客 API 协议：
- 入口：`POST /ws/`
- 请求：`{ "msg": "<apiName>", "vo": { ... } }`
- 返回：
  - 成功：`{ code: 200, ... }`
  - 失败：`{ code: 4xx/5xx, info: "..." }`

鉴权：
- 统一使用 `userId/token`，并通过 `getUserInfo(...)` 校验。
- 未通过鉴权返回 `code:403`。

## 3. 数据模型（Mongo）

集合名建议：`RPAFlowsLatest`（或 `rpa_flows_latest`，按现有命名习惯确定一种并保持一致）

文档结构：

```json
{
  "_id": "ObjectId",
  "userId": "u123",
  "flowId": "weibo_search_read_list",
  "version": 7,

  "kind": "rpa",
  "capabilities": ["read.list", "query.selector"],
  "filters": [{"key":"domain","value":"s.weibo.com"},{"key":"locale","value":"zh-CN"}],
  "ranks": {"quality": 0.86, "cost": 0.2, "speed": 0.7},

  "status": "DRAFT",
  "visibility": "private",

  "digest": "sha256:...",
  "content": { "id":"weibo_search_read_list", "start":"...", "steps":[...] },

  "authorSignature": {
    "alg": "ed25519",
    "kid": "author-k1",
    "sig": "...",
    "signedAt": "ISODate"
  },
  "systemSignature": {
    "alg": "ed25519",
    "kid": "system-k1",
    "sig": "...",
    "signedAt": "ISODate",
    "reviewComment": "...",
    "reviewedBy": "reviewerUserId"
  },

  "published": {
    "isPublished": false,
    "channel": null,
    "publishedAt": null
  },

  "createdAt": "ISODate",
  "updatedAt": "ISODate"
}
```

### 3.1 字段约束

- `userId + flowId` 唯一。
- `version` 为整数，提交成功时自增（首次为 1）。
- `content` 为对象，不是 JSON 字符串。
- `digest` 必须由 `content` 计算得到。
- `kind/capabilities/filters/ranks` 必须从 `content` 抽取，客户端不可直接信任。

### 3.2 索引

- 唯一索引：`{ userId: 1, flowId: 1 }`
- 查询索引：`{ userId: 1, updatedAt: -1 }`
- 查询索引：`{ "published.isPublished": 1, flowId: 1, updatedAt: -1 }`
- 可选索引（find 优化）：
  - `{ kind: 1 }`
  - `{ capabilities: 1 }`
  - `{ "filters.key": 1, "filters.value": 1 }`

## 4. Flow 内容抽取规则

服务端在每次提交时，从 `content` 自动抽取：

- `kind`：
  - 优先 `content.kind`
  - 无则默认 `rpa`
- `capabilities`：
  - 优先 `content.capabilities`
  - 支持数组和对象形式归一化为字符串数组（与现有 `FlowRegistry` 行为一致）
- `filters`：
  - 取 `content.filters`，归一化为 `{key,value}` 数组
- `ranks`：
  - 取 `content.ranks`（对象）

校验：
- `content.id` 必须等于 `flowId`；不一致拒绝提交。

## 5. digest 与签名

## 5.1 digest

`digest` 定义：
- 对 `content` 做稳定序列化（canonical JSON，键排序）
- 计算 `SHA-256`
- 存储格式：`sha256:<hex>`

## 5.2 双签名

- `authorSignature`：作者提交签名（可选进入发布链路前必填，策略可配置）
- `systemSignature`：系统审核/批准后签名（发布必需）

发布约束：
- `published.isPublished=true` 前必须存在有效 `systemSignature`。

## 6. 状态机

建议状态：
- `DRAFT`
- `SUBMITTED`
- `APPROVED`
- `REJECTED`
- `PUBLISHED`
- `UNPUBLISHED`

最小强约束：
- `PUBLISHED` 必须有 `systemSignature`。
- `REJECTED` 必须有审核说明（可存在 `systemSignature.reviewComment` 或独立审核字段）。

## 7. findFlow 策略

`findFlow` 必须与现有 `invoke.find` 语义对齐（`must/prefer/filter/rank`）。

## 7.1 输入结构

```json
{
  "kind": "rpa",
  "must": ["cap.a", "cap.b"],
  "prefer": ["cap.x"],
  "filter": [{"key":"domain","value":"s.weibo.com"}],
  "rank": "quality,cost"
}
```

## 7.2 候选范围（scope）

- `mine`：仅当前 `userId` 的 Flow
- `published`：仅已发布 Flow
- `all`：`mine + published`

默认：`all`

## 7.3 评分与排序

两阶段：

1) 硬过滤（不满足即淘汰）
- `kind` 必须匹配
- `must` 必须全部命中
- `filter` 按 key 分组，必须组组命中（精确值或 `*` 通配）

2) 软排序
- `preferHits`（降序）
- `filterScore`（降序，精确命中高于通配命中）
- `rank`（按字段顺序比较；`cost/size` 升序，其余降序）
- `updatedAt`（降序）
- 稳定兜底（`flowId` 字典序）

## 7.4 mine 与 published 取舍

当其它分数完全一致时，按 `ownershipPolicy` 决定：
- `preferMine`（默认）
- `preferPublished`
- `mineOnly`
- `publishedOnly`

默认：`preferMine`

## 8. Flow 相关 API（/ws msg）

以下 API 名称为本阶段约定，后端实现必须使用 `apiMap[msg]` 挂载。

### 8.1 `saveFlowDraft`

用途：创建/更新当前用户 Flow（覆盖 latest）

`vo`：
- `userId`, `token`
- `flowId`
- `content`
- `authorSignature`（可选）

行为：
- 校验鉴权
- 校验 `content.id == flowId`
- 抽取 `kind/capabilities/filters/ranks`
- 计算 `digest`
- `version = old.version + 1`（无旧记录则 1）
- upsert 保存

返回：
- `code:200`
- `flowId`, `version`, `digest`, `status`

### 8.2 `getMyFlow`

用途：获取本人某 flow 最新版

`vo`：
- `userId`, `token`
- `flowId`

返回：
- `code:200`, `flow`

### 8.3 `findFlow`

用途：按 `find` 查找 Flow（可用于调用前下载）

`vo`：
- `userId`, `token`
- `find`（同 7.1）
- `scope`（`mine|published|all`）
- `ownershipPolicy`（可选）
- `topK`（可选，默认 1）
- `download`（可选，默认 false）

返回：
- `code:200`
- `best`（最佳匹配）
- `candidates`（可选）
- `explain`（打分解释）
- `flow`（`download=true` 时返回）

### 8.4 `publishFlow`

用途：发布本人 Flow（需要系统签名）

`vo`：
- `userId`, `token`
- `flowId`
- `systemSignature`
- `reviewComment`（可选）
- `channel`（可选）

行为：
- 校验可发布条件（至少包含有效 `systemSignature`）
- 设置 `published.isPublished=true`
- `published.publishedAt=now`
- 状态置为 `PUBLISHED`

返回：
- `code:200`, `flowId`, `version`, `published`

## 9. 并发与一致性

- `saveFlowDraft` 使用原子更新与版本自增，防止并发覆盖。
- 对同一 `userId + flowId` 的并发写，后写入者版本必须更大。
- `findFlow` 只读最新文档，不做跨版本拼接。

## 10. 错误码建议

- `400` 参数错误 / 内容格式错误
- `401` 缺失鉴权参数
- `403` 鉴权失败 / 无权限
- `404` 目标 flow 不存在
- `409` 签名或状态冲突（例如无系统签名请求发布）
- `500` 服务内部错误

## 11. 后续兼容预留

本规范保留以下扩展位，不影响当前实现：
- 历史版本表（append-only）用于回滚/审计。
- query cache 同构管理（上传/审核/签名/发布/查找）。
- 远端 provider 对接（替换本地 registry）。

