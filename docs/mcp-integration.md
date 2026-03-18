# MCP 使用指南（当前 AgentHub 系统）

## 1. 这份指南解决什么问题
这份文档面向接入方和维护方，说明当前系统中 MCP Gateway 的使用方式：
- 如何访问 MCP 接口
- 如何做 `initialize / tools/list / tools/call`
- 如何启用可选 token 鉴权
- 如何用 smoke test 快速验证

## 2. 当前实现范围
当前 MCP Gateway 为 HTTP JSON-RPC 入口，已实现：
- `initialize`
- `tools/list`
- `tools/call`

当前不包含（后续规划）：
- prompts/resources
- streamable response

## 3. 服务地址与入口

### 3.1 路由入口
MCP 统一入口：
- `POST /mcp`

请求体中通过 `method` 区分调用方法（JSON-RPC 2.0）。

### 3.2 基础 URL
服务基础地址由你的服务部署决定，常见为：
- `http://127.0.0.1:<PORT>`

例如你的环境中是 `3301`：
- `http://127.0.0.1:3301/mcp`

## 4. 鉴权机制（可选）

### 4.1 开关规则
在 `.env` 配置：
- `MCP_AUTH_TOKEN=<your-token>`

行为如下：
- 未配置 `MCP_AUTH_TOKEN`：不要求鉴权
- 配置了 `MCP_AUTH_TOKEN`：必须携带 `Authorization: Bearer <token>`

未通过鉴权返回：
- HTTP `401`
- `{"error":"Unauthorized"}`

### 4.2 示例
```bash
curl -s http://127.0.0.1:3301/mcp \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer your-secret-token' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

## 5. 方法说明与示例

### 5.1 initialize
请求：
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {}
}
```

返回要点：
- `protocolVersion`
- `capabilities.tools`
- `serverInfo`

说明：
- 当前实现里，`initialize` 主要是握手与能力声明。
- 即使不先调 `initialize`，`tools/list` 和 `tools/call` 也可工作。

### 5.2 tools/list
请求：
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {}
}
```

返回结构：
- `result.tools`: 工具数组

典型 tool：
```json
{
  "name": "TestNodeChat.agent.js",
  "description": "Empty node.js backend AI Agent. (TestNodeChat)",
  "inputSchema": {
    "type": "object",
    "properties": {
      "input": {"type": ["string","number","object","array","boolean","null"]},
      "prompt": {"type": ["string","number","object","array","boolean","null"]},
      "timeoutMs": {"type": "number", "minimum": 1000},
      "language": {"type": "string"}
    },
    "additionalProperties": true
  }
}
```

内建工具：
- `agenthub.ping`（用于 MCP 网关健康验证）

### 5.3 tools/call
请求：
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "TestNodeChat.agent.js",
    "arguments": {
      "input": "hello from mcp",
      "timeoutMs": 120000,
      "language": "EN"
    }
  }
}
```

成功响应结构：
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [{"type": "text", "text": "..."}],
    "structuredContent": {}
  }
}
```

失败响应结构：
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "error": {
    "code": -32001,
    "message": "Error: ..."
  }
}
```

## 6. 工具命名与按需启动

### 6.1 工具命名
工具名格式：
- `<nodeName>.<agentPath>`

示例：
- `TestNodeChat.agent.js`
- `WikipediaSearch.agent.js`

### 6.2 节点启动策略
- `tools/list` 不会强制启动节点
- `tools/call` 会按需启动对应 `AgentNode`（若未启动）

## 7. Smoke Test（推荐）
项目内置脚本：
- `npm run test:mcp:smoke`
- 脚本文件：`scripts/mcp-smoke-test.mjs`

默认流程：
1. `initialize`
2. `tools/list`
3. `tools/call`

默认调用工具：
- `agenthub.ping`

环境变量：
- `BASE_URL`：覆盖目标地址
- `MCP_TOOL`：指定测试工具
- `MCP_NODE`：指定节点（调用具体 agent 时）
- `MCP_INPUT`：测试输入
- `MCP_TIMEOUT_MS`：超时
- `MCP_START_NODE`：是否先通过 `/ws` 启动节点
- `MCP_AUTH_TOKEN`：如果开启鉴权，脚本会自动带 Bearer token
- `ENV_FILE`：指定 dotenv 文件路径

示例：
```bash
# 默认读取当前目录 .env
npm run test:mcp:smoke

# 指定具体工具
MCP_TOOL=TestNodeChat.agent.js MCP_NODE=TestNodeChat npm run test:mcp:smoke

# 指定 token
MCP_AUTH_TOKEN=your-secret-token npm run test:mcp:smoke
```

## 8. 常见问题

### 8.1 `AgentHub not ready`
原因：`AhSystem` 未初始化完成或 `AGENT_HUB` 未启用。
建议：
- 确认服务启动参数包含 `AGENT_HUB=TRUE`
- 等待服务完全启动后再调用

### 8.2 `401 Unauthorized`
原因：配置了 `MCP_AUTH_TOKEN`，但请求未携带正确 Bearer token。
建议：
- 检查 `Authorization` 请求头
- 检查 token 是否一致、是否有前后空格

### 8.3 `tools/call` 返回业务错误（如分支错误）
原因：工具对应的 agent 本身执行失败（非 MCP 通道故障）。
建议：
- 先用 `agenthub.ping` 验证网关链路
- 再单独排查该 agent 的业务逻辑/模型配置/用户上下文

### 8.4 连不上端口
原因：服务未监听目标端口，或当前执行环境网络受限。
建议：
- 本机先 `curl http://127.0.0.1:<PORT>/`
- 如在受限沙箱中测试，改为在宿主环境执行

## 9. 代码位置（便于维护）
- MCP 路由：`routes/mcp.js`
- 工具列表与调用映射：`agenthub/AhSystem.mjs`
- 一次性执行路径：`agenthub/AhAgentNode.mjs`
- Smoke 脚本：`scripts/mcp-smoke-test.mjs`
- Todo 规划：`MCP-TodoList.md`

