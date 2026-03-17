# Agent 系统设计与使用文档（AgentNode / AgentHub）

## 1. 文档目标
本文档描述当前 Agent 系统的核心机制与落地点，覆盖以下主题：
- 注册（Register）
- 发现（Discovery）
- 调用（Invocation）
- 管理（Lifecycle / Operations）

同时提供配置、时序、排障与扩展指引，便于使用者接入和维护者演进。

## 2. 架构总览

### 2.1 核心组件
- AgentHub 系统管理器：`agenthub/AhSystem.mjs`
- Hub 侧节点代理：`agenthub/AhAgentNode.mjs`
- Node 侧运行时（JS）：`agenthub/AgentNode.mjs`
- Node 侧入口（JS）：`AgentNodeMain.mjs`
- Node 侧运行时（Python 兼容实现）：`agents/tabos/AgentNode.py`

### 2.2 组件职责
- `AhSystem`
  - 扫描静态节点目录
  - 启停节点进程
  - 对外提供 Hub API（Start/Stop/List/CreateSession/XTerm 等）
  - 处理节点 websocket 注册入口 `RegisterAgentNode`
- `AhAgentNode`
  - 表示一个“已知节点”的 Hub 侧代理实例
  - 负责拉起子进程、维护节点 websocket
  - 维护 session/terminal 映射
  - 负责 Hub <-> Node 消息转发与 call 回调匹配
- `AgentNode`
  - 读取节点配置 `agent.json`
  - 连接 Hub websocket 并注册
  - 创建/管理会话 `ChatSession`
  - 执行 Agent、转发调用、处理终端消息

### 2.3 总体数据流
- 控制面：Hub API -> `AhSystem` -> `AhAgentNode`
- 执行面：`AhAgentNode` <==websocket==> `AgentNode`
- 会话面：Session 在 Hub 与 Node 双侧各自维护映射，通过 `sessionId` 关联

## 3. 术语
- AgentHub：系统中负责节点管理与统一 API 的服务端能力（`AhSystem`）
- AgentNode：具体 Agent 执行节点（Node.js 或 Python 进程）
- Static Node：被扫描到且 `agent.json` 中 `entry && expose` 的节点
- External Node：运行时通过 websocket 主动注册到 Hub 的节点
- Session：一次聊天/任务执行上下文，跨 Hub/Node 双侧同步
- XTerm：终端会话（交互式 shell）

## 4. 注册机制（Register）

### 4.1 启动路径
1. 调用 Hub API `StartAgentNode`（或静态节点 autoStart）
2. `AhSystem.startAgentNode()` 创建 `AhAgentNode`
3. `AhAgentNode.start()` 读取 `agent.json`，启动子进程（Node/Python）
4. 子进程入口通常为 `AgentNodeMain.mjs`，内部实例化 `AgentNode`
5. `AgentNode` 连接 Hub websocket，并发送注册消息

### 4.2 注册消息
Node 打开 websocket 后发送：
- `msg: "CONNECT"`
- `selector: "RegisterAgentNode"`
- `name: <nodeName>`
- `info: <agent.json + 运行时信息>`

Hub 在 `AhSystem.setup()` 中通过 websocket selectorMap 绑定 `RegisterAgentNode`，收到后：
- 若 `nodeMap` 不存在同名节点，创建 `AhAgentNode`
- 调用 `AhAgentNode.OnNodeConnect(ws, msg)`
- 保存 node websocket，更新节点元信息
- 回发 `{"msg":"CONNECTED"}` 作为握手完成信号

### 4.3 连接保持
- Hub 侧 `AhAgentNode` 每 2 秒向 Node 发送 `State` 心跳请求
- Node 收到 `State` 后返回当前 `workload`
- Hub 更新节点负载状态

## 5. 发现机制（Discovery）

### 5.1 静态发现
`AhSystem.scanAgents(autoStart)` 扫描 `agentDir` 子目录：
- 读取 `<agentDir>/<node>/agent.json`
- 满足 `entry && expose` 进入 static list
- 若 `autoStart` 且节点 `autoStart` 为 true，则自动启动

### 5.2 动态发现
- websocket 注册成功的节点会进入 `AhSystem.nodeMap`
- 不要求必须在静态目录中存在（可视为外部节点接入）

### 5.3 统一查询接口
`AhListAgentNodes` 返回“静态 + 运行态”合并视图：
- 静态节点：`active=false, external=false`
- 运行节点：`active=true, external=true`（并覆盖同名静态信息）

返回字段包含：
- `name`
- `description`
- `chatEntry`
- `userGroups`
- `agents`
- `active`
- `external`

## 6. 调用机制（Invocation）

### 6.1 消息模型
系统采用两类通信原语：
- Message（单向通知）
- Call（请求-响应，带 `callId`）

约定字段：
- `msg`: 消息类型
- `session` / `sessionId`: 会话关联
- `callId`: 请求响应匹配 ID
- `message`: 包含 `msg` 与 `vo` 的业务载荷

### 6.2 Hub -> Node
主要由 `AhAgentNode.send()` / `AhAgentNode.callNode()` 发起：
- `CreateSession`
- `ExecAgent`
- `Message`
- `Call`
- `XTermData`
- `XTermResize`

### 6.3 Node -> Hub
主要由 `AgentNode.callHub()` / `AgentNode.sendToHub()` 发起：
- `CallHub`：调用 Hub API 能力
- `CallClient`：让 Hub 侧 session 反向调用前端客户端
- `MessageToClient`：向客户端推送消息
- `CallResult`：返回上一次 Call 结果
- `State`：状态/负载上报

### 6.4 会话创建与执行
1. 客户端请求 Hub API `AhCreateSession`
2. `AhSystem.createSession()` 获取目标 `AhAgentNode`
3. `AhAgentNode.newSession()` 创建 `AhSession` 并启动
4. Hub 向 Node 下发 `CreateSession`
5. Node 创建 `ChatSession`，回发 `SessionReady`
6. 后续通过 `ExecAgent` 驱动 Node 侧 `session.execAgent(...)`
7. 结束后 Node 回发 `EndExecAgent`

### 6.5 Call 回调匹配
- Hub 侧：`AhAgentNode.callMap` 保存 `callId -> callback/error`
- Node 侧：`AgentNode.callMap` 保存 `callId -> resolve/reject`
- 收到 `CallResult` 后按 `callId` 回填并删除 map 条目

### 6.6 超时策略
`AgentNode.callHub()` 使用超时定时器兜底：
- 支持 `vo.timeout` 覆盖
- 超时后删除 map 条目并 reject

## 7. 管理机制（Lifecycle / Ops）

### 7.1 启停控制
- `StartAgentNode`
  - 支持 `options.forceRestart`
  - 支持 `options.checkUpdate`
- `StopAgentNode`
  - 停止节点并清理映射

### 7.2 热更新检测
`AhAgentNode.checkUpdate()` 通过目录最新修改时间与 `entryDate` 对比：
- 若检测到更新，可触发 stop + restart

### 7.3 进程管理
`AhAgentNode.start()` 根据入口扩展名分流：
- `.mjs/.js`：`node <entry> ...`
- `.py`：`python <entry> ...`（可选 conda 激活）

停止时：
- 优先结束执行中 session（返回 shutdown 错误）
- 清理 sessionMap
- kill 子进程（SIGKILL）或关闭 node websocket

### 7.4 终端管理（XTerm）
Hub API：
- `XTermCreate`
- `XTermClose`

链路：
- Hub 侧 `AhXTerm` 与 Node 侧 `termMap` 通过 `sessionId` 关联
- Node 处理 `XTermData` 和 `XTermResize`

## 8. 配置说明

### 8.1 Hub 配置
文件：`agents/agenthub.json`
常见字段：
- `host`：Node 连接地址（ws）
- `devKey`：开发密钥（可被 Node 继承）
- `language`：默认语言

环境变量：
- `AGENT_HUB_AGENTDIR`：Agent 目录
- `AGENT_HUB_CONDAPATH`：conda 路径
- `AGENT_HUB_CONDAENV`：默认 conda env

### 8.2 Node 配置
文件：`<agent>/agent.json`
常见字段：
- `name`
- `description`
- `entry`
- `expose`
- `autoStart`
- `checkUpdate`
- `conda`
- `debugPort`
- `devKey`
- `chatEntry`
- `userGroups`
- `agents`

## 9. 典型时序

### 9.1 注册时序
1. Hub 调用 `StartAgentNode`
2. Hub 启动子进程
3. Node websocket 连接 Hub
4. Node 发送 `CONNECT + RegisterAgentNode`
5. Hub `OnNodeConnect` 完成绑定
6. Hub 回 `CONNECTED`
7. 周期性 `State` 心跳开始

### 9.2 执行时序（CreateSession + ExecAgent）
1. 客户端调用 `AhCreateSession`
2. Hub 创建 `AhSession`
3. Hub -> Node: `CreateSession`
4. Node 创建 `ChatSession`
5. Node -> Hub: `SessionReady`
6. Hub -> Node: `ExecAgent`
7. Node 执行 agent
8. Node -> Hub: `EndExecAgent`

### 9.3 终端时序（XTerm）
1. 客户端调用 `XTermCreate`
2. Hub 创建 `AhXTerm`
3. Hub/Node 建立 sessionId 对应 terminal
4. 客户端输入 -> `XTermData`
5. 尺寸变化 -> `XTermResize`
6. 结束时调用 `XTermClose`

## 10. 错误处理与排障

### 10.1 常见问题
- 节点启动失败
  - 检查 `agent.json` 是否可读、`entry` 是否存在
  - 检查 Python/conda 环境
- 节点已启动但不在线
  - 检查 websocket 地址 `host`
  - 检查防火墙/端口
- 调用超时
  - 检查 `callId` 回传是否完整
  - 检查业务处理是否阻塞
- Session not found
  - 检查 `session`/`sessionId` 字段一致性
- XTerm 无输出
  - 检查 Node `termMap` 是否已注册对应 sessionId

### 10.2 推荐日志关键字
- `RegisterAgentNode`
- `AgentNode<name> connected`
- `SessionReady`
- `EndExecAgent`
- `CallResult`
- `State`

## 11. 安全与权限
- `devKey` 可用于节点到 Hub 的能力鉴权透传
- Hub 在 session 场景会透传用户 `userId/token` 到 callHub 入参
- 外部节点注册时建议在接入层做来源限制与鉴权校验

## 12. 扩展指南

### 12.1 新增 Hub API 能力
1. 在 `AhSystem.setup()` 的 `apiMap` 注册新接口
2. 若需 Node 主动调用，在 `AhAgentNode.callHub()` 路径可达
3. 如需节点内置快捷处理，可加入 `AhAgentNode.handlerMap`

### 12.2 新增 Node 消息类型
1. Hub 侧在 `AhAgentNode.OnNodeConnect()` 的 message switch 增加分支
2. Node 侧在 `AgentNode.onMessage()` 增加对应处理
3. 补充 `CallResult` 或单向消息规范

### 12.3 新增语言实现
- 参考 Python 版 `agents/tabos/AgentNode.py`
- 保持 websocket 协议字段兼容（msg/session/callId/message）
- 先确保注册 + Session + CallResult 最小闭环

## 13. 附录：Hub API 索引（当前实现）
- `StartAgentNode`
- `StopAgentNode`
- `AhCreateSession`
- `AhListAgentNodes`
- `AhNodeState`
- `AhInstallAgentNode`（预留，未完整实现）
- `XTermCreate`
- `XTermClose`
- `AhGetAgentSpecs`
- `AhGetAgentKindSpec`

## 14. 附录：协议字段最小约定

### 14.1 Call
```json
{
  "msg": "Call",
  "session": "optional-session-id",
  "callId": "string-id",
  "message": {
    "msg": "BusinessMethod",
    "vo": {}
  }
}
```

### 14.2 CallResult
```json
{
  "msg": "CallResult",
  "session": "optional-session-id",
  "callId": "string-id",
  "result": {},
  "error": "optional-error-string"
}
```

### 14.3 Message
```json
{
  "msg": "Message",
  "session": "optional-session-id",
  "message": {
    "msg": "BusinessEvent",
    "vo": {}
  }
}
```
