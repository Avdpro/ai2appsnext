# Agent 接入指南（如何编写可接入当前系统的 Agent）

## 1. 目标
本文档面向“新建一个可被 AgentHub 管理和调用的 AgentNode 项目”。
完成后你应能做到：
- 被 Hub 正常启动并注册
- 能在节点列表里被发现
- 能创建会话并执行 Agent 脚本
- 能被停止和重启

相关实现参考：
- `agenthub/AhSystem.mjs`
- `agenthub/AhAgentNode.mjs`
- `agenthub/AgentNode.mjs`
- `AgentNodeMain.mjs`

## 2. 接入前提
- 目录位于 Hub 的 `agentDir`（默认 `agents/`）下
- 目录内有可解析的 `agent.json`
- `agent.json.entry` 指向可启动入口
- 入口进程必须使用现有 AgentNode 协议（推荐直接复用现成入口）

## 3. 推荐目录结构

### 3.1 Node.js Agent（推荐）
```text
agents/
  MyAgent/
    agent.json
    agent.js
```

### 3.2 Python Agent
```text
agents/
  MyPyAgent/
    agent.json
    agent.py
```

## 4. `agent.json` 怎么写

### 4.1 Node.js 最小示例
```json
{
  "name": "MyAgent",
  "label": "MyAgent",
  "expose": true,
  "description": "My first node agent.",
  "entry": "../../AgentNodeMain.mjs",
  "chatEntry": null,
  "agents": ["agent.js"],
  "debugPort": 5001,
  "autoStart": false,
  "checkUpdate": false
}
```

### 4.2 Python 最小示例
```json
{
  "name": "MyPyAgent",
  "expose": true,
  "description": "My first python node agent.",
  "entry": "../tabos/AgentNodeMain.py",
  "agents": ["agent.py"],
  "autoStart": false,
  "checkUpdate": false
}
```

### 4.3 字段说明（最常用）
- `name`: 节点名，建议与目录同名
- `expose`: 是否出现在静态扫描列表中
- `entry`: 节点运行时入口，不是业务 agent 文件
- `agents`: 业务 agent 列表，供会话执行
- `chatEntry`: 可选，聊天入口
- `autoStart`: Hub 启动时是否自动拉起
- `checkUpdate`: 启动时是否检查目录变更并重启
- `debugPort`: Node 调试 websocket 端口（JS AgentNode 实现）
- `conda`: Python 节点可选 conda 环境名

## 5. 业务 Agent 脚本怎么写

当前系统里，业务脚本通常采用“导出 async agent(session)”约定。

### 5.1 Node.js 最小模板（`agent.js`）
```js
export default async function agent(session) {
  return {
    isAIAgent: true,
    session,
    name: "agent",
    autoStart: true,
    context: {},
    async execChat(input) {
      await session.addChatText("assistant", `echo: ${String(input ?? "")}`);
      return { result: { ok: true } };
    }
  };
}

export { agent };
```

### 5.2 Python 最小模板（`agent.py`）
```python
async def agent(session):
    async def exec_agent(input):
        await session.addChatText("assistant", f"echo: {input}", {})
        return {"result": {"ok": True}}

    return {
        "isAIAgent": True,
        "session": session,
        "name": "agent",
        "autoStart": True,
        "context": {},
        "execChat": exec_agent,
    }

default = agent
__all__ = ["default", "agent"]
```

注意：
- 你可以直接参考现有样例：
  - `agents/TestNodeChat/agent.js`
  - `agents/TestPyChat/agent.py`
- 生成式模板中有大量 Cody 标记代码，最小可运行并不要求这些标记。

## 6. 接入流程（注册 / 发现 / 调用 / 管理）

### 6.1 注册（Register）
1. 调 Hub API `StartAgentNode`，参数至少包含 `name`
2. Hub 启动 entry 进程
3. 节点进程连回 Hub websocket 并发送 `RegisterAgentNode`
4. Hub 回 `CONNECTED`，注册完成

### 6.2 发现（Discovery）
调用 `AhListAgentNodes`：
- 能看到你的节点，并检查：
  - `name` 是否正确
  - `active` 是否为 `true`（已运行）
  - `external` 标记是否符合预期

### 6.3 调用（Invocation）
1. 调 `AhCreateSession`，参数 `node=<你的节点名>`
2. 拿到 `sessionId`
3. 触发执行（系统内会通过 `ExecAgent` 下发到 Node）
4. 观察 `EndExecAgent` 返回

### 6.4 管理（Lifecycle）
- 停止：`StopAgentNode`
- 重启：再次 `StartAgentNode` 或 `forceRestart`
- 更新重载：`checkUpdate=true` 时会比较目录修改时间

## 7. 调试与排障

### 7.1 启动失败
- 检查 `agent.json` 是否可解析
- 检查 `entry` 路径是否真实存在
- Python 节点检查 `python/conda` 可用性

### 7.2 已启动但不活跃
- 查 Hub 日志是否出现 `RegisterAgentNode`
- 查节点日志是否已连接 websocket
- 检查 `host` 配置和端口

### 7.3 会话或调用失败
- 确认 `AhCreateSession` 的 `node` 名称匹配
- 确认 `agents` 列表里脚本存在
- 确认业务脚本导出函数签名正确

### 7.4 终端异常（如果你用 XTerm）
- 检查 `sessionId` 是否一致
- 检查 Node 侧 `termMap` 是否已注册

## 8. 上线前检查清单
- `agent.json` 能被正确读取
- `StartAgentNode` 成功
- `AhListAgentNodes` 可见且 `active=true`
- `AhCreateSession` 成功返回 `sessionId`
- 至少一次 `ExecAgent` 成功返回
- `StopAgentNode` 后资源释放正常

## 9. 常见建议
- `name` 与目录名保持一致，便于排障
- 先做最小 echo Agent 跑通全链路，再加工具调用
- 生产环境建议关闭不必要的 debug 输出
- 如果 Agent 要对外公开，才设置 `expose=true`

## 10. 参考文件
- `agenthub/AhSystem.mjs`
- `agenthub/AhAgentNode.mjs`
- `agenthub/AgentNode.mjs`
- `AgentNodeMain.mjs`
- `agents/TestNodeChat/agent.json`
- `agents/TestNodeChat/agent.js`
- `agents/TestPyChat/agent.py`
