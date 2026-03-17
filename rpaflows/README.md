# rpaflows

一个面向 Web 自动化的 Flow 引擎：把浏览器操作拆成可编排的步骤（Flow），再用规则缓存 + AI 解析提高跨站点可用性。

## 核心特点

- Flow 化执行：`start + steps + next`，支持分支、重试、子流程调用。
- 原子动作丰富：`goto/click/input/wait/selector/run_ai/run_js/invoke/invokeMany/upload/download/readPage/readElement`。
- AI + 规则混合定位：`query -> selector` 可缓存到站点规则，降低重复解析成本。
- 人机协同：支持 `ask_assist`、selector 人工监督与手动 pick。
- 多页面模型：支持 `scope=current/newest/any` 的跨 tab 查找与等待。
- 可观测性：每次运行会写入 `flow-logs/`，返回结构化 `history/vars/lastResult`。

## 快速开始

### 1) 环境准备

- Node.js 18+（推荐 20+）
- Firefox 可执行文件路径（用于 WebDriver 直连模式）

安装依赖：

```bash
npm install
```

配置 `.env`（至少建议包含）：

```bash
WEBDRIVE_APP=/Applications/Firefox.app/Contents/MacOS/firefox
AI_PROVIDER=openai
OPENAI_API_KEY=your_key
```

说明：
- 如果只跑纯规则/纯脚本 flow，AI Key 可不填。
- AI 也支持 `ollama/google/anthropic`，详见 `AIProviderClient.mjs` 的环境变量读取逻辑。

### 2) 跑一个最小 smoke flow

```bash
node run-flow.mjs --flow=flows/flow-smoke.json --alias=smoke_open
```

### 3) 跑本地 smoke 套件

```bash
npm run smoke:testpages
```

该命令会自动检查/拉起本地测试页服务（默认 `127.0.0.1:8787`），并顺序执行多条 smoke flow。

## 常用命令

```bash
# 页面助手（selector pick + 页面内 AI 助手）
npm run page:assistant -- --url=https://example.com

# 将 skill 文本转换为 flow JSON
npm run skill:toflow -- --input=./skills/weibo-search.md --out=./flows/generated-weibo-search.json

# 单条 flow 运行（可配 args/opts）
node run-flow.mjs --flow=flows/xxx.json --args=./xx.args.json --opts=./xx.opts.json

# 仅做安全审计（不执行 flow）
node audit-flow.mjs --flow=flows/xxx.json --args=./xx.args.json --audit-mode=enforce --audit-ai=true --out=/tmp/flow-audit.json
```

`run-flow.mjs` 额外常用参数：

- `--url=` 初始打开地址（可选）
- `--alias=` 浏览器会话别名
- `--hold-ms=` 结束后保持窗口时长
- `--supervise-selector=true` 开启 selector 人工监督
- `--ai-provider=...` / `--ai-selector-provider=...` / `--ai-run-ai-provider=...` 覆盖 AI 提供方
- `--audit-mode=warn|enforce|off` Flow 审核模式（默认 `warn`）
- `--audit-allow-actions=click,scroll,goto` 审核白名单（可选）
- `--audit-deny-actions=run_js,uploadFile` 审核黑名单（可选）
- `--audit-ai=true|false` 是否启用 AI 语义审计（`audit-flow.mjs` 默认 `true`）
- `--audit-ai-tier=fast|balanced|quality` AI 审计模型档位
- `--audit-ai-provider=openai|openrouter|google|anthropic|ollama` 指定 AI 供应商（可选）
- `--audit-ai-model=<model>` 指定 AI 模型（可选）
- `--audit-ai-run-js-with-code=true|false` 是否对 `run_js` 带 `code` 的步骤也做 AI 审计（默认 `false`，默认只审 `query-only run_js`）

对应环境变量：

- `FLOW_AUDIT_MODE`
- `FLOW_AUDIT_ALLOW_ACTIONS`
- `FLOW_AUDIT_DENY_ACTIONS`
- `FLOW_AUDIT_AI_ENABLED`
- `FLOW_AUDIT_AI_TIER`
- `FLOW_AUDIT_AI_PROVIDER`
- `FLOW_AUDIT_AI_MODEL`
- `FLOW_AUDIT_AI_TIMEOUT_MS`
- `FLOW_AUDIT_AI_RUN_JS_WITH_CODE`

高级审计建议：

- 审计机制默认是“报告模式”，不会主动阻断执行；
- `enforce` 在当前实现仅表示“按高风险标准标记 `wouldBlock=true`”，用于分级与审批，不会直接拒绝运行；
- `audit-flow.mjs` 适合在 CI 中产出审计报告（JSON）并由上层系统决定是否拦截发布。

## 项目结构

```text
.
├── flows/                 # Flow 与通用动作脚本
├── rules/                 # 站点规则缓存（按域名）
├── flow-logs/             # 运行日志
├── run-flow.mjs           # Flow CLI 入口
├── FlowRunner.mjs         # Flow 调度器
├── FlowStepExecutor.mjs   # Action 执行器
├── FlowQueryResolver.mjs  # Query 解析与校验
├── FlowAIResolver.mjs     # run_ai / selector AI 调用
├── FlowGoalDrivenLoop.mjs # 目标驱动循环执行
└── rpa-flow-spec-v0.55.md # Flow 规范（当前主版本）
```

## Flow 能力与边界

- 当前规范版本：`v0.55`（见 `rpa-flow-spec-v0.55.md`）。
- 支持 `invoke`/`invokeMany` 子流程复用，可组合成能力网络。
- `setChecked` 与 `setSelect` 已在规范与校验层声明，但执行器中当前仍是未实现状态（会返回 failed）。

## 输出与调试

- 运行结果会打印 JSON（含 `status/reason/value/vars/history/meta`）。
- 日志默认写到 `flow-logs/`，并在终端输出日志文件路径。
- 规则缓存默认写到 `rules/*.json`，用于复用 selector 与查询结果。

## 适用场景

- 跨站点、可复用的 Web 自动化流程
- 需要可回放、可审计、可插拔 AI 的浏览器任务
- 从“技能描述”半自动生成 flow 的场景（`skill:toflow`）
