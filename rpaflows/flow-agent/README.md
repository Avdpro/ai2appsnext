# Flow Agent (Generate + Revise)

Shared workspace for AI-assisted flow generation and revision.

## Goals
- One shared pipeline for `generate` and `revise`.
- Pluggable engines: `default`, `codex`, `claude_code`.
- Keep output validation centralized.

## Directory layout
- `index.mjs`: public API used by callers.
- `run-flow-agent.mjs`: simple CLI wrapper.
- `prompts/`: engine-agnostic system prompt templates.
- `context/`: spec + capability context builders.
- `runners/`: engine adapters.
- `validators/`: final output checks.
- `schemas/`: JSON schema references.
- `fixtures/`: smoke input examples.

## Quick start

### Generate (default engine)
```bash
node ./flow-agent/run-flow-agent.mjs \
  --mode=generate \
  --engine=default \
  --text="打开微博搜索，输入关键词，读取前10条结果" \
  --out=./temp/flow-agent-generate.json
```

### Revise (default engine)
```bash
node ./flow-agent/run-flow-agent.mjs \
  --mode=revise \
  --engine=default \
  --flow=./flows/search.json \
  --instruction="把读取步骤改成invoke read.list，并保留原有step id" \
  --out=./temp/flow-agent-revise.json
```

## Engine notes
- `default`: uses internal `SkillToFlow.mjs` (`skillToFlow` / `reviseFlowDocumentByPrompt`).
- `codex`: external CLI adapter (set `FLOW_AGENT_CODEX_CMD`).
- `claude_code`: external CLI adapter (set `FLOW_AGENT_CC_CMD`).

External engines are expected to return strict JSON:
```json
{
  "flow": { "id": "...", "start": "...", "steps": [] }
}
```
or
```json
{
  "document": { "flow": { "id": "...", "start": "...", "steps": [] } }
}
```
