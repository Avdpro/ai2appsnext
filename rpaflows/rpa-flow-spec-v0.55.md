# RPA Flow 生成规范（v0.55）

> 这是 **v0.55 完整版**（不是增量）。
> v0.55 更新要点：
> - 新增 `ask_assist` 持久化参数：`persistAcrossNav` / `persistTtlMs` / `reopenDelayMs` / `tipPollMs` / `tipTimeoutMs`，用于 in-page prompt/tip 在页面跳转/刷新后自动恢复（见 6.1.5 与 Action Union）
> - 新增 `invoke.fork`：支持在子执行时 fork 隔离页面上下文（`false` 旧行为；`true` 复用当前页 fork；`string` 表示先打开该 URL 再 fork 执行，见 8.1）
> - 新增 `invokeMany`：通用批量子调用动作（支持并发、每项模板参数、每项 fork、结果聚合），用于替代专用 batch action（见 8.1.2）
> - `goto` 新增 `newPage?: boolean`：当为 true 时，先创建新 tab/page，再在新页执行导航（默认 false）
> - 新增 `closePage`：用于关闭页面；支持 `target:"active"|"flow"|"contextId"|"urlMatch"`，其中 `target:"flow"` 表示关闭当前 Flow 使用/打开过的全部页面（见 Action Union）
> - 变更：取消 `next: { router:"routerId" }`（Flow 不再暗含 RouterMap 依赖）；保留 `next: { router: Function }` 作为动态路由兜底，并要求显式 `unsafe:true`，且 router 必须只读/无副作用（见 4.3）
> - 变更：QuerySpec 在 kind="selector" 时，`policy` 默认从 `"single"` 调整为 `"pool"`（更符合“多候选试探”的默认策略）
> - 新增 `readElement`：读取当前页面中元素的单一材料（text/value/html/rect/attr:\*），支持 `multi`
> - 新增 `setChecked`：将 checkbox/radio/开关设置到确定勾选状态（幂等，含验证），可选 `multi`
> - 新增 `setSelect`：将 `<select>`/下拉选择器设置到确定选项（value/label/index；幂等，含验证）
> - 新增 `readPage`：用于显式读取页面材料（`url/title/html/article/screenshot`）；`field` 支持单项字符串或多项对象（如 `{url:true,article:true}`），返回读取结果或对象（见 6.1.3 与 Action Union）
> - `selector` 增加 `multi?: boolean`，用于声明是否期望多选（或必须唯一）；执行器据命中数量决定 done/failed，并在 `result.meta.count` 返回数量
- **补充：新增 `query` 的对象模式 `QuerySpec`（兼容原 `string`）**：用于声明 query 产物的 kind（selector/status/code/value）以及 selector 的 `mode(instance|class)`、`policy(single|pool)`、`share` 等策略（见 5.1.1）
- **补充：`query` / `by` 支持数组（tuple）**：用于同一 action 需要多个元素定位输入（例如 `dragDrop` 的 source/dest）；执行器应按 index 批量解析并写回 `by[]`（见 5.3）
> - 明确多页面运行时模型：执行器维护 `pages[]`（仅存活页面，按创建顺序 append）与 `currentPage`；因此 `scope:"newest"` = `pages[pages.length-1]`；`scope:"any"` 推荐按 newest→current→其它页（从新到旧）查找（见 6.1.4）
> - `selector` / `wait` 新增 `autoSwitch?: boolean`（默认 true）：当 `scope` 为 `newest/any` 且命中发生在非 current 页面时，默认自动切换 `currentPage` 到命中页；并规定二者的 `result.value` 必带 `page`（执行后 currentPage 信息）与 `matchedPage`（命中页信息，若成功）（见 6.1.4 与 Action Union）
> - Flow 顶层新增可选 `vars` 声明（建议放在 `steps` 之后）：仅用于可读性/提示/静态检查，不作为硬约束
> - 新增插值模式 `${{ ... }}`：在允许插值的字段中，除 `${path}` 外，也允许写“整串 JS block”以便输出非字符串类型/做轻量计算（见 2.2.2）
> - 扩展 `Step.saveAs`：除旧的 `saveAs:"x"` 外，新增对象映射模式 `saveAs:{k:FlowVal,...}`，可一次写入多个 vars，并支持保存部分结果/常量/插值计算结果（见 3.1）
> - 新增 `run_ai`：用于“总结/归纳/分类/结构化输出”等需要 AI 推理的任务；强制返回 JSON envelope（`{status:"ok",result}` / `{status:"error",reason}`）；支持 `page` 注入（`url/html/screenshot/article`）与抽象 `model` 档位（`fast|balanced|quality|vision|free`），并可用 `schema` 约束 `ok.result` 结构（见 6.1.2 与 Action Union）
> - **补充说明：`run_ai` 的 envelope 字段 `ok.result` 会由执行器映射为本 step 的 `StepResult.value`；因此 Flow 中的插值与 `saveAs` 应读取 `${result.value}`（而不是 `${result}`）**
> - `input` 新增 `clear?: boolean`：当为 true 时，先清空当前焦点输入框内容，再按 `mode`（type/paste）输入；保留 `mode:"fill"` 作为旧语义别名，等价于 `{mode:"type", clear:true}`（见 6.1.1）
> - `input` 新增 `caret?: "end" | "start" | "keep"`：用于在输入前定位光标；**默认 "end"**（追加输入更稳）。如需保留旧行为（不改动 click 后的光标/选区），显式写 `caret:"keep"`（见 6.1.1）。
> - `click` 新增 `expectInputFocus?: boolean`（默认 false）：用于“点击后必须聚焦输入元素”的场景。为 true 时，若点击后未确认输入焦点，执行器应判定失败（可按实现触发 selector 再生成/重试）。
> - 新增 Action 通用等待参数 `postWaitMs?: number`：用于动作成功后进入下一步前的短暂稳定期（默认 0；常用于 Enter 提交后等待 200–500ms）
> - `uploadFile` 重做：支持 `files: FileSpec[]` 一次上传多个文件；每个文件可用 `path` 或 DataURL `data` 提供；其中 `path` 支持本机磁盘路径与内部索引路径 `hub://...`（见 Action Union 的 `uploadFile` 定义与 13.14 约束）
> - 保留并包含 v0.23 的全部内容（含 run_js 的 query/cache 机制、StepResult、vars/saveAs、Cond.source 扩展等）
> - **新增约束：`run_js` 必须“只读/不改变页面状态”**（仅用于提取/计算/生成/定位/状态校验；禁止导航/DOM 变更/触发交互/网络/存储写入/计时器循环等；见 7.1.4）


---

## 目标
将原本线性 Action 数组升级为可分支的流程图（Flow），用 `next` 描述控制流，实现：
- 成功/失败/超时等分支
- 显式等待（wait step）代替隐式观测（obs）
- 元素定位使用 `query`（自然语言描述）在运行时解析为 `by`
- `input` 不负责定位，只对当前焦点输入（必须先 click 激活）
- `wait` 以“元素状态”为主，支持跨页面（新 tab/window）等待
- `selector` 用于“探测元素是否存在”（不等待），并可输出解析后的 `by`
- `invoke` 用于“调用其它 agent/flow”（如 blocker 清理、login、logoff 等）
- `press_key` 用于“纯按键交互”（Esc/Tab/箭头/快捷键）
- `branch` 用于仅基于参数的多分支路由（不触碰页面，不执行代码）
- Action 支持 `postWaitMs` 作为“动作后稳定期”等待（默认 0）
- 通过 args 让 Flow 可复用：标题、正文、图片等均以参数传入

---

## 0. 关键约束：capability key / filter key / rank 不得杜撰
编写 Flow 时，系统会提供一份“定义文件”（例如 `rpa.mjs` 或类似的 mjs）作为能力与参数的权威来源。
- AI **必须**以该定义文件为准来引用 capability key（cap/arg 一体化）、filter key、以及 rank 可用字段。
- AI **不得**自行杜撰不存在的 key。
- 若定义文件中缺少某能力/参数，AI 应改用：
  - 更通用的能力（如 `domain:"*"` 兜底）
  - 或 `ask_assist` 请求人工介入
  - 或在 `done`/`abort` 中明确说明缺失点（避免瞎编）

---

## 1. 顶层结构（Flow）

> v0.27：Flow 可选包含 `vars` 声明（建议放在 `steps` 之后）。该声明用于可读性/提示/静态检查，**不作为强约束**；即使未声明也允许在运行时通过 Step.saveAs 写入 vars。

> Flow 必须包含 `id`：根据该 Flow 的功能总结提炼的短标识，用于注册/复用/检索（建议全小写 + 下划线）。

### 1.1 Flow（含参数声明 args）
```ts
type Flow = {
  id: string;         // Flow 唯一标识（根据功能总结提炼的短名，如 "compose_post" / "write_article"）
  start: string;      // 起始 step id
  steps: Step[];      // 按顺序列出步骤（便于阅读与保持字段顺序）
  capabilities?: string[]; // 可选：能力键集合（cap/arg token），用于 invoke.find 匹配与复用检索（如 "compose.start","fill","fill.target"）
  filters?: { key: string; value: string }[]; // 可选：该 Flow 的筛选标签（如 domain/locale），供 invoke.find.filter 匹配
  vars?: Record<string, VarDef>; // 可选：局部变量声明（建议放在 steps 后；仅用于可读性/提示，不作为强约束）

  // 可选：参数声明（用于说明/校验；执行时实际参数由调用方传入）
  args?: Record<string, ArgDef>;
};
```

```ts
type ArgDef = {
  type: "string"|"number"|"boolean"|"object"|"array"|"dataurl"|"file"|"any";
  required?: boolean;
  desc?: string;
};


type VarDef = {
  desc?: string; // 简述该变量用途
  type?: "string"|"number"|"boolean"|"object"|"array"|"any"; // 可选：仅用于提示/静态检查
  from?: string; // 可选：来源提示（例如 "stepId.saveAs" 或 "multiple"）
};
```

---

## 2. 调用参数（call.args）与插值（Interpolation）

### 2.1 执行器接口约定：调用时传入 call.args
```ts
type FlowCall = {
  // opts 典型用途：
  // - opts.silent: true 表示“禁止与用户交互”，执行器在遇到 ask_assist 时应直接 failed/走分支（不要弹窗等待）
  //   同时，branch 的 Cond 可用 source:"opts" 读取 opts 来主动分支（见 6.2.3）
  // - 其它策略：locale、全局超时、重试策略等（由你们实现约定）

  flow: Flow;
  args: Record<string, any>;                 // 实参/values（业务数据：标题/正文/图片等）
  opts?: Record<string, any> | null;         // 可选：运行环境/策略参数（如 silent 等）；默认 null
};
```

例（写文章）：
```json
{
  "title": "2026 产品发布说明",
  "body": "......长文本......",
  "cover": { "filename": "cover.png", "data": "data:image/png;base64,..." },
  "publish": true
}
```

可选：调用方也可以传入 `opts`（运行策略/环境参数），例如：
```json
{
  "silent": true,
  "locale": "zh-CN"
}
```

---

### 2.2 插值语法：`${path}` 与 `${{ ... }}`（安全 path + 可选 JS block）

> v0.20 扩展：插值支持 `${vars.xxx}`，用于从局部变量 vars 读取（vars 由 Step.saveAs 写入）。
> - `${title}` 仍然默认从 `call.args` 读取（兼容旧写法）。
> - `${vars.post.url}` 表示从 `vars.post.url` 读取。
> - 同样只允许安全 path（标识符/点号/数字索引方括号）。

> 约定：插值默认从 `call.args` 读取（如 `${title}`）；并支持显式指定源：
> - `${args.xxx}` / `${xxx}`：从 `call.args` 读取（默认源）
> - `${vars.xxx}`：从本次运行局部变量 `vars` 读取（vars 由 Step.saveAs 写入）
> - `${opts.xxx}`：从 `call.opts` 读取（运行策略/环境参数；若 opts 为 null 则视为不存在）
> - `${result.xxx}`：从“上一步 StepResult”读取（执行器提供；见 4.5）
> 
> 说明：`${path}` 始终只允许安全 path（不支持任意表达式/JS），而 `${{ ... }}` 提供一个受控的 JS block（见 2.2.2）。
在允许插值的字段里：
- 字符串可包含 `${path}`，执行器会在运行时按规则替换（默认从 `call.args` 读取，可显式指定 `vars/opts/result/args`）。
- 也可使用“整串 JS block”`${{ ... }}` 来生成值（见 2.2.2）。

- ✅ `${title}` → 取 `call.args.title`
- ✅ `${datasheet.name}` → 取 `call.args.datasheet.name`
- ✅ `${images[0].data}` → 取 `call.args.images[0].
#### 2.2.2 JS block 语法：`${{ ... }}`（受控执行，返回原始类型）

在允许插值的字段中，除 `${path}` 外，新增支持一种 **“整串 JS block”** 写法：`${{ ... }}`。

**触发条件（重要）**
- 仅当字符串 **整体** 完全匹配 `${{ ... }}` 时才会执行（例如 `"${{ 1+1 }}"`）。
- 若 `${{ ... }}` 只是出现在更长的字符串中（例如 `"x=${{1+1}}"`），**不执行**，按普通字符串处理（避免混合模板导致可读性/安全性下降）。

**执行上下文**
- JS block 在严格模式下执行（`"use strict"`）。
- 仅暴露四个只读入参：`args`、`opts`、`vars`、`result`（分别对应 `call.args`、`call.opts`、局部变量、上一步 StepResult）。
- 建议：执行器不应向 JS block 暴露其它全局能力（如 DOM/WebDriver/网络/文件 IO 等）。

**返回值与类型**
- 若 block 中包含 `return`，则以 `return` 的结果为值。
- 若不包含 `return`，执行器可将其视为一个表达式并隐式返回（例如 `${{ args.publish === true }}`）。
- 与 `${path}` 的“整串返回原始类型”规则一致：`${{ ... }}` 的结果 **不强制转字符串**，可返回 `object/array/number/boolean` 等原始类型。

**安全与约束（强烈建议）**
- `${{ ... }}` 属于“执行代码”能力，风险远高于 `${path}`。强烈建议执行器提供开关（例如 `opts.allowJsBlock === true` 才启用），并在默认情况下禁用或仅对受信 Flow 启用。
- 当 JS block 执行异常时，执行器可以选择：
  - `status:"failed"`（更严格、更易排障），或
  - 返回空字符串并记录 warning（更宽松，但可能掩盖错误）。

**示例**
- 生成布尔值：`"${{ args.publish === true }}"`
- 生成对象：`"${{ return { title: args.title, hasCover: !!args.cover } }}"`
- 读取上一步结果：`"${{ return (result && result.value) ? result.value.url : "" }}"`

data`

#### Path 语法（安全子集）
只允许以下形式的 path：
- 标识符：`title`
- 点号访问：`datasheet.name`
- 数字索引：`images[0].data`
- 组合：`a.b[0].c`

明确禁止（针对 `${path}`）：
- 任何函数调用/运算符/模板嵌套（`${path}` 不支持 JS 表达式）
- `()`, `+`, `? :`, `||`, 反引号等

---

### 2.3 转义：写字面量 `${`
如果需要输出字面量 `${`（不是插值），使用反斜杠转义：

- 输入：`\${not_a_var}`
- 输出：`${not_a_var}`（不替换）

> 约定：执行器在解析插值时，应忽略被 `\` 转义的 `${`。

---

### 2.4 缺失值处理（推荐约定）
当 path 不存在或值为 `null/undefined`：
- 推荐：替换为空字符串 `""`，并记录一条 warning（不让流程直接崩）
- 但若该参数在 `Flow.args` 标记为 required，执行器可选择在 Flow 启动前直接报错（可选实现）

---

### 2.5 插值白名单（哪些字段允许 `${path}` / `${{ ... }}`）
为避免混乱与注入，插值只在以下字段生效（建议白名单策略）：（插值包含 `${path}` 与 `${{ ... }}` 两种）

**强烈建议支持（高频刚需）**
- `input.text`
- `goto.url`
- `uploadFile.files[].path`
- `uploadFile.files[].filename`
- `uploadFile.files[].data`
- `dialog.value`
- `ask_assist.reason`
- `invoke.args`（对象内任意 string 值允许插值）
- `invoke.find.filter.value`

**可选支持（谨慎）**
- `query` / `query.text`（见 2.6：会影响固化/缓存）

**明确不做插值（保持安全与可预测）**
- `by`（避免注入脆弱 selector）
- `run_js.code`（必须是“纯无参函数代码”，避免模板注入）
- `branch` 的 Cond.value / Cond.values 通常为常量（不需要插值）

---

### 2.6 `query` / `query.text` 的插值与固化规则（不引入 queryKey）
- 允许在 `query`（或 `query.text`）中使用插值（`${path}` 或 `${{ ... }}`，用于动态目标描述）。
- **但只要 `query`（或 `query.text`）含任何未转义的 `${`（包括 `${path}` 与 `${{ ... }}`），该 query 即视为“带参数 query”。**
- 对“带参数 query”：执行器 **不得保存/固化 query→by 记忆规则**（每次重新解析/交给 AI）。
- 对“不带参数 query”：可按现有机制保存/固化 query→by 规则（提升效率）。

> 实现提示：判断“带参数 query”的最简方式是检测未转义的 `${` 子串（`${path}` 与 `${{ ... }}` 都会命中）。

---

## 3. Step 结构（字段顺序固定）

### 3.1 局部变量 vars 与 Step.saveAs
- 执行器在一次 Flow 运行中维护一个只属于该次运行的 `vars: Record<string, any>`（局部变量）。
- `Step.saveAs` 用于把本步骤的执行产出保存到 `vars`：
  - **旧模式（字符串）**：若设置 `saveAs:"x"`，则在该 step 执行结束后写入：`vars.x = result.value`。
    - 规范建议：`saveAs` 字符串应写“裸变量名”（如 `"x"`），不要写 `"vars.x"`。
    - 兼容建议：执行器可将误写的 `"vars.x"` 归一化为 `"x"` 再写入（容错）。
  - 默认只保存 **result.value**（不保存整个 result），避免 vars 污染。
  - **新模式（对象映射）**：若设置 `saveAs:{ key1: FlowVal1, key2: FlowVal2, ... }`，则在该 step 执行结束后，逐项写入：
    - 对每个条目 `k: vSpec`，先计算 `v = parseFlowVal(vSpec, args, opts, vars, result)`（其中 `result` 为**本 step 的执行结果**），然后写入 `vars[k] = v`。
    - `FlowVal` 与其它“允许插值”的字段一致：支持 `${path}`（安全子集路径）与“整串 JS block”`${{ ... }}`（见 2.2.2）。当 `vSpec` 是**纯** `${path}` 或**纯** `${{ ... }}` 时，返回并保存原始类型（对象/数组/数字/布尔等），不强转为字符串；当 `vSpec` 为更长字符串时，仅对其中的 `${path}` 做插值替换（`${{ ... }}` 只有在整串匹配时才执行）。
    - 若 `vSpec` 不是字符串（如 boolean/number/object/null），按常量直接保存到 `vars[k]`（不做插值）。
- 安全建议：执行器应拒绝危险 key（如 `__proto__`/`constructor`/`prototype`）以防原型污染。

示例：
```js
// 旧模式：把 result.value 存到 vars.post
{ id:"s1", action:{ type:"query", query:"the post card" }, saveAs:"post", next:{ done:"s2" } }

// 新模式：一次写入多个 vars，且可只存部分字段/常量
{
  id:"s1",
  action:{ type:"query", query:"the post card" },
  saveAs:{
    post: "${result.value}",          // 等价于旧模式 saveAs:"post"
    postUrl: "${result.value.url}",   // 只保存 value 的一部分
    didQuery: true,                   // 常量：标记本步执行过
    metaCount: "${result.meta.count}" // 保存 meta 字段（若存在）
  },
  next:{ done:"s2" }
}
```


### Step（字段顺序必须是：id、desc、action、next）
> **命名规则（Step.id）**：`id` 必须符合 **JS 变量名风格的 lowerCamelCase**，并且**不允许下划线**。  
> - **必须匹配**：`^[a-z][A-Za-z0-9]*$`（只允许字母与数字；首字母小写；无 `_` / `-` / 空格）  
> - **语义建议**：`动词 + 名词 + [For条件/When条件] + [Fallback/Retry]`  
> - **示例**：`clickTitle`、`clickContentForTitleFallback`、`inputTitle`、`routePublish`、`doneOk`、`abort`

```ts
type Step = {
  id: string;        // 全局唯一 step id（lowerCamelCase；不允许下划线）
  desc?: string;     // 一句话说明该步意图（用于日志/可视化）
  action: Action;    // 原子动作（只做一件事）
  saveAs?: string | Record<string, any>;   // 可选：保存本 step 的产出到 vars；字符串=旧模式，对象=映射模式（见 3.1）
  next?: Next;       // 控制流跳转
};
```

约束：
- `id` 全局唯一
- 每个 step 只做一个“原子动作”（不要 click+input 合并）
- `desc` 建议 ≤ 40 字
- `done/abort` 通常不需要 `next`
- 对 `branch`：建议该 step **不写 next**（branch 自己决定下一步）

---

## 4. Next（控制流）

### 4.1 直接跳转
```js
next: "someStepId"
```

### 4.2 按结果分支（推荐）
```ts
type NextByStatus = {
  done?: string;
  failed?: string;
  timeout?: string;
  skipped?: string;
};
```

### 4.3 动态路由（router，兜底）
```ts
type NextRouter =
  | { router: Function; args?: any; unsafe: true };
```

规范：
- **仅保留 `router: Function`**。取消 `{ router:"routerId" }`，避免 Flow 暗含对外部 RouterMap/Registry 的依赖。
- **必须显式声明 `unsafe: true`**（没有该字段则视为非法 next 定义）。
- router **必须只读/无副作用**：只能基于 `args/vars/opts/result` 与 `next.args` 做判断并返回下一步的 stepId；不得执行页面操作、网络/IO，不得直接修改 `args/vars/opts/result`（需要写入 `vars` 必须通过普通 step 的 `saveAs` 机制完成）。
- router 的返回值约束：必须返回一个 **存在的 stepId（string）**；返回 `null/undefined/空字符串/不存在的 stepId` 或抛异常，都应使本 step 进入 `failed`，并在 `reason`/`meta` 中记录 router 错误信息，便于排查。

---


## 4.5 StepResult（步骤执行结果，统一规范）

执行器在每个 step 执行完成后，必须产出一个 `StepResult` 对象，并用于：
- `next` 分支判定（done/failed/skipped/timeout）
- `Cond.source:"result"` 的读取
- `Step.saveAs` 写入 `vars`（写入 `result.value`）
- 日志与调试

```ts
type StepResult = {
  status: "done" | "failed" | "skipped" | "timeout"; // 必填：本 step 的结果状态
  value?: any;        // 可选：本 step 的产出（成功/部分成功的返回值）
  reason?: string;    // 可选：失败/跳过/超时的解释（建议 ≤200 字）

  // 可选：当动作涉及元素定位时，返回最终使用/解析出的 by（便于固化与调试）
  by?: string;

  // 可选：结构化诊断信息（机器可读），例如 durationMs、matched/count、scope 等
  meta?: Record<string, any>;

  // 可选：执行器内部异常摘要（不要求堆栈）
  error?: { name?: string; message?: string };
};
```

约定：
- `next` 的 `done/failed/skipped/timeout` 分支与 `result.status` 一一对应。
- `Step.saveAs` 默认写入 `vars[saveAs] = result.value`。
- 对 `selector`：建议 `status` 用 done/failed 表达“是否找到”；并在 `by` 回填最终选择器。
- 对 `wait`：超时应使用 `status:"timeout"`（不要混到 failed）。

## 5. Query 与 by（元素定位，重要）

### 5.1 query（自然语言目标描述）
`query` 用于让 resolver 生成稳定的 `by`（或在带参数时交给 AI）。

推荐写法包含：
- 元素类型：按钮/链接/输入框/卡片/菜单/上传入口…
- 可见文本：例如“文本包含 ‘Add tag’ 的按钮”
- 属性线索：aria-label/placeholder/name/data-testid/id 等
- 语境锚点：例如“在‘标签’区域内”

避免：
- 纯位置描述（右上角第2个）
- 依赖脆弱结构（nth-child）

### 5.1.1 QuerySpec（新增：query 的对象模式，兼容 string）

> 兼容性：本规范中所有出现 `query: string` 的 Action 字段，均允许写成 `query: QuerySpec`；若仍为 string，则按旧语义处理。  
> 目的：让“元素定位/脚本生成/状态判断”等需求用统一的 `query` 承载，并明确产物类型与缓存策略（尤其是 selector 的 `instance/class` 与 `single/pool`）。

```ts
type QuerySpec =
  | string
  | {
      // 自然语言描述（等价于旧版 string query）
      text: string;

      // 期望产物类型（用于缓存/执行策略；默认 "selector"）
      // - selector: 解析为 by/selector（用于 click/selector/wait/readElement 等）
      // - status:   仅缓存/读取 status（done/failed/skipped）
      // - code:     生成/缓存脚本（例如 run_js 的 query→code）
      // - value:    缓存/读取结构化 value（不共享）
      kind?: "selector" | "status" | "code" | "value";

      // 仅当 kind="selector" 时有效：
      // - instance: 单实例（定位“这个按钮/这个输入框”）；更强调区分度
      // - class:    类选择器（定位“这一类元素”，如帖子卡片/列表项）；更强调泛化与稳定
      mode?: "instance" | "class";

      // 仅当 kind="selector" 时有效：
      // - single: 认为 selector 唯一/单一；新值可直接替换旧值
      // - pool:   认为 selector 可能有多种可用写法；保存为候选池并按新近/成功率置顶
      policy?: "single" | "pool";

      // policy="pool" 时的最大候选长度（默认 10）
      maxLen?: number;

      // selector 是否允许“跨 key 共享”
      // - true:  基于 sigKey 共享（同 sigKey 的不同 step/key 可复用）
      // - false: 仅对当前 key 私有（不进入共享 elements，或 sigKey 为空）
      share?: boolean;

      // 可选：允许附带视觉信息（模板/网格/点击偏移/描述等）用于高阶匹配
      allowVision?: boolean;

      // 可选：稳定性提示（用于 class 模式避免把动态正文带进 sigKey 的核心部分）
      stabilityHint?: "high" | "medium" | "low";

      // 可选：用于 loose 匹配的标签（比“全文 text 完全一致”更稳）
      tags?: string[];
    };
```

#### 5.1.1a 默认规则（当字段省略时）
- `kind` 默认 `"selector"`。
- `kind:"selector"` 时：
  - `mode` 默认 `"instance"`。
  - `policy` 默认 `"pool"`。
  - `share` 默认 `true`（若执行器实现了基于 sigKey 的 elements 共享）；否则可忽略。
  - `maxLen` 默认 `10`（仅对 `policy:"pool"` 生效）。

#### 5.1.1b QuerySpec 与固化/缓存的关系（规范性建议）
- 若 `query`（或 `query.text`）包含任何未转义的 `${`（包括 `${path}` 与 `${{...}}`），视为“带参数 query”：
  - 执行器 **不得固化** `query → by` 规则（每次重新解析/交给 AI）。
  - 对 `policy:"pool"` 的 selector 也应谨慎落盘（可选择仅本次内存缓存）。
- `mode:"instance"`：优先提升“区分度”（如按钮文本/图标 hint）以避免同容器下多个可点击元素 sigKey 冲突。
- `mode:"class"`：优先提升“泛化与稳定”，避免把大段动态内容（如帖子正文）写进 sigKey 的核心部分；动态文本可作为辅助信息（例如写入 `vision.desc` 或 `reason`）。

#### 5.1.1c 示例
- 单实例按钮（默认 single）：
```json
{ "text": "发布/发送/提交（Post/Publish/Send/Submit）按钮：用于把当前已编辑好的内容发布出去", "kind": "selector", "mode": "instance", "policy": "single" }
```
- 列表类元素（class + pool，便于多种 selector 兜底）：
```json
{ "text": "帖子卡片（feed item / post card），用于遍历列表", "kind": "selector", "mode": "class", "policy": "pool", "maxLen": 10, "stabilityHint": "high" }
```
- 用 tags 支持 loose：
```json
{ "text": "正文编辑器输入区域", "kind": "selector", "tags": ["compose", "editor", "body"] }
```


### 5.2 by（可执行选择器字符串：css/xpath）
`by` 必须遵循以下格式之一：

1) **CSS（推荐）**
- 写法：`"css: <标准 CSS 选择器>"`
- 示例：
  - `css: button[aria-label="Post"]`
  - `css: input[name="tag"]`
  - `css: input[type="file"]`

2) **XPath（用于按文本或复杂结构匹配）**
- 写法：`"xpath: <XPath 表达式>"`
- 示例：
  - `xpath: //button[contains(normalize-space(.),"Accept")]`
  - `xpath: //div[@role="dialog"]//button[contains(.,"Close")]`

规则与建议（重要）：
- 建议始终写前缀（css/xpath），避免歧义
- 优先使用稳定锚点：`[id]`、`[data-testid]`、`[aria-*]`、`[name]`、`[href*=]`、`[placeholder*=]`
- 避免脆弱的 `:nth-child(...)`
- 按文本定位优先 XPath 的 `contains(normalize-space(.), "...")`

---

### 5.3 `query` / `by` 的数组（tuple）模式（用于同一 action 需要多个定位输入）

> 背景：大多数复杂交互可以用多 step 组合完成；但少数动作（例如 `dragDrop`）在语义上天然需要同时定位两个元素（source 与 dest）。  
> 目标：在**不引入新的 locators 结构**的前提下，让执行器以统一方式支持“一个 action 多个定位输入”。

#### 5.3.1 类型与兼容性

- 兼容旧写法：`query` 与 `by` 仍然可以是单个值。
- 新增 tuple 写法：`query` 与 `by` 允许写成数组，数组项按 **index** 对齐。

```ts
type QueryInput = QuerySpec | QuerySpec[];
type ByInput    = BySpec    | BySpec[];
```

> 说明：本规范中所有声明 `query` / `by` 的 Action 字段，均可套用该规则；但**仅当确有必要**时才推荐使用数组（例如 `dragDrop`）。

#### 5.3.2 执行器（task runner）对 tuple 的规范化规则（强约束）

当执行器在 action 中检测到 `query` 字段时：

1) 若 `query` 为单个值（`QuerySpec`）：  
   - 执行一次 `query → by` 转换  
   - 写回：`action.by = by`

2) 若 `query` 为数组（`QuerySpec[]`）：  
   - 对每个 `query[i]` 独立执行一次 `query[i] → by[i]` 转换  
   - 写回：`action.by = by[]`（数组，长度至少与 query 相同）

3) `by` 的预填与长度不一致：  
   - 若 `by` 不是数组，视为“未预填”，执行器应生成完整 `by[]`  
   - 若 `by` 是数组但长度不足，执行器应补齐缺失项  
   - 若 `by[i]` 已存在且非空：执行器可以跳过转换，或仍转换并更新缓存（实现可选，但应保持行为一致）

4) **缓存 key 的 index 约定（建议实现为强约束）**：  
   - 为避免 tuple 内多个 query 覆盖同一个 cache 记录，执行器应使用 `stepKey + "#"+i` 作为各项 query 的缓存 key（例如 `compose_dragDrop#0`、`compose_dragDrop#1`）。  
   - 写入 ruleMap 时，tuple 的每一项独立拥有自己的 key 与（可共享的）element 绑定。

5) 与 `QuerySpec.kind` 的关系：  
   - 仅当 `querySpec.kind` 缺省或为 `"selector"` 时，执行器才应进行 `query → by` 转换并写回 `by`。  
   - 若 `kind` 为 `"code"|"value"|"status"`，执行器应走对应的 rule 存取逻辑，但**不得**把结果写入 `by`。

#### 5.3.3 `dragDrop` 的 index 语义约定（强约束）

当 `action.type === "dragDrop"` 且 `query`/`by` 使用数组时：
- `query[0]` / `by[0]`：source（拖拽源元素）
- `query[1]` / `by[1]`：dest（投放目标元素）

示例：

```json
{
  "type": "dragDrop",
  "query": [
    { "text": "要拖拽的元素（source）", "kind": "selector", "mode": "instance" },
    { "text": "拖拽投放目标区域（dest）", "kind": "selector", "mode": "instance" }
  ]
}
```

> 备注：如未来需要 handle（拖拽把手）等第三定位输入，仍可扩展为 `query[2]` / `by[2]`，但建议谨慎使用并在动作定义中明确 index 语义。



## 6. Action（原子动作定义）

### 6.1 通用约定
- 使用 `action.type`
- 需要定位元素的动作使用 `query`；可选 `by`
- 缺少 `by` 时，执行器会将 `query -> by`
- `input` 不带 query/by：必须先 `click` 激活输入焦点；可用 `caret` 控制输入前光标位置（默认 `end`）
- 子能力（blocker 清理、login/logoff 等）统一用 `invoke`
- 参数分支优先用 `branch`，不要滥用 `run_js` 或 `router(function)`


### 6.1.1 input（对当前焦点输入）

`input` **不负责定位元素**，只对“当前焦点（active element）”输入。因此通常应先用 `click` 激活目标输入框，再执行 `input`。

#### 字段
- `text: FlowVal`：要输入的内容（支持 `${path}` 与整串 `${{ ... }}`；与其他可插值字段一致）
- `mode?: "fill" | "type" | "paste"`：
  - `type`：逐字输入（更像真实键盘）
  - `paste`：粘贴输入（更适合长文本）
  - `fill`：**兼容旧语义**。自 v0.27 起等价于 `{ mode:"type", clear:true }`（见下）
- `clear?: boolean`（默认 `false`）：若为 `true`，执行器应在输入前**清空当前焦点控件的内容**（建议实现为 “全选 → 删除”，并触发必要的 input/change 事件）。
- `caret?: "end" | "start" | "keep"`（默认 `"end"`）：输入前的光标定位策略。
  - `"end"`：将光标移动到当前值的末尾（追加输入，**v0.28 默认**，更稳）
  - `"start"`：将光标移动到开头（前插输入）
  - `"keep"`：保持 `click`/页面脚本所设置的光标与选区（**兼容 v0.27 默认行为**）
- `pressEnter?: boolean`：输入完成后额外按一次 `Enter`（用于搜索/发送/提交等）

#### 语义规则（兼容 + 新能力）
1) 若 `mode === "fill"`：
   - 视为旧模式覆盖输入，等价于 `mode:"type"` 且 `clear:true`。
   - 兼容旧 Flow：即使没有写 `clear` 也会先清空再输入。
2) 若 `mode !== "fill"` 且 `clear === true`：
   - 先清空，再按 `mode` 执行输入（例如 `clear:true + mode:"paste"` 用于“先清空再粘贴长文本”）。
3) `caret` 的处理时机（**在清空之后、输入之前**）：
   - 若未提供 `caret`：默认按 `caret:"end"` 处理（v0.28 默认）。
   - `caret:"end"`：将光标移动到末尾后再输入（“追加式写入”更稳）。
   - `caret:"start"`：将光标移动到开头后再输入（“前插式写入”）。
   - `caret:"keep"`：不改变光标/选区（等价 v0.27 默认行为，适合依赖页面脚本定位光标的场景）。
   - 执行器实现建议：
     - 对 `<input>/<textarea>` 优先使用 `setSelectionRange()`；
     - 对 `contenteditable` / 富文本编辑器采用 best-effort（Selection/Range），若不可用可退化为模拟按键或直接保持不变。
4) 若 `mode` 省略：
   - 默认 `mode:"type"`（与旧实现保持一致）。
5) 当 `text` 为整串 `${path}` 或整串 `${{ ... }}` 时：
   - 解析器可返回非字符串（对象/数字/布尔等）；但 **输入动作最终应将其转为字符串** 再输入（例如 `String(value)`），以保证行为确定。

#### 推荐写法
- 覆盖短文本（兼容旧写法）：
```json
{ "type":"input", "text":"${args.title}", "mode":"fill" }
```
- 覆盖长文本（推荐：先清空再粘贴）：
```json
{ "type":"input", "text":"${args.body}", "mode":"paste", "clear": true }
```
- 仅追加输入（不清空）：
```json
{ "type":"input", "text":"...more...", "mode":"type" }
```

- 追加输入（v0.28 默认 `caret:"end"`，可显式写出来以增强可读性）：
```json
{ "type":"input", "text":"...more...", "mode":"type", "caret":"end" }
```
- 保持 click 后的光标/选区位置（兼容 v0.27 默认行为）：
```json
{ "type":"input", "text":"...insert...", "mode":"type", "caret":"keep" }
```

---

## 6.2 branch（参数分支，多分支，推荐）

### 6.1.2 run_ai（让 AI 做总结/归纳/分类/结构化输出）

当任务本质是“理解内容并产出结构化结果”（例如：总结文章要点、提炼卖点/风险、情感倾向判断、把长文本归纳为 JSON 等），仅靠 `run_js` 往往不够直接或可维护。此时可使用 `run_ai`。

`run_ai` 是 **纯推理/纯变换** 动作：它不与页面交互、不发网络、不做副作用；只是把给定输入（可选附带页面上下文）按 `prompt` 转换为一个可判定的 JSON 结果，供后续 step 继续分支或写入变量。

#### 字段
- `prompt: string`：任务指令（建议写成“明确约束 + 期望输出”，避免闲聊）
- `input?: FlowVal | Array<{ name?: string; value: FlowVal }>`：
  - 可直接传一段材料（字符串/对象/数组皆可，按 FlowVal 解析与插值）
  - 或传多段命名材料（例如 `title/article/comments`），方便模型区分上下文
- `schema?: object`：可选。用于约束 **成功时** 的 `result` 结构（JSON Schema；仅约束 `result`，不约束 envelope）
- `page?: { url?: boolean; html?: boolean; screenshot?: boolean; article?: boolean }`：可选。声明是否向模型注入“当前页面上下文”
  - `url:true`：注入当前页面 URL
  - `html:true`：注入 **visible + 清洗 + 裁剪后的 HTML**（默认不提供 full HTML；避免噪声与体积爆炸）
  - `screenshot:true`：注入 **viewport 截图的 DataURL（PNG）**（默认不截 full-page）
  - `article:true`：注入通过 Readability 等算法抽取的“文章内容”（便于总结/要点提炼；见下文 PAGE.ARTICLE）
- `model?: "fast" | "balanced" | "quality" | "vision" | "free"`：可选。抽象档位选择（不是具体模型名）
  - `fast`：速度/成本优先（轻量抽取、短摘要、简单分类）
  - `balanced`（默认）：速度与质量折中（大多数总结/归纳场景）
  - `quality`：质量/稳健优先（长文、多条件、推理更复杂的归纳）
  - `vision`：需要看图（通常配合 `page.screenshot:true`）
  - `free`：尽量使用低成本/空闲资源池（适合低优先级批量任务；质量可能不稳定）


#### PAGE.ARTICLE（当 `page.article:true` 时注入）
当启用 `page.article:true`，执行器应在模型输入中额外注入一段 **可用于直接总结的“文章抽取结果”**（建议使用 Readability 或同类算法）。该对象用于降低“网页噪声/导航/推荐流”对总结的干扰。

注入的对象建议为（示例字段；执行器可按实现细化，但应保持字段稳定）：

```ts
type PageArticle = {
  title?: string;        // 文章标题（若可得）
  byline?: string;       // 作者/来源（若可得）
  siteName?: string;     // 站点名（若可得）
  lang?: string;         // 语言（若可得）
  excerpt?: string;      // 摘要/导语（若可得）
  contentHtml: string;   // Readability 提取后的正文 HTML（已裁剪/去噪）
  contentText: string;   // 正文纯文本（由 contentHtml 转换而来；便于模型直接处理）
};
```

- 若抽取失败（例如页面结构不适配、内容为空），建议仍注入 `contentHtml:""` 与 `contentText:""`，并在上层 step 的 `result.meta`（执行器自定义字段）记录失败原因；`run_ai` 由模型自行决定返回 `{status:"error",reason}` 或对空内容给出合理说明。
- 与 `page.html:true` 的区别：`page.html` 是“可见区域清洗 HTML”，更贴近当前屏幕；`page.article` 是“正文抽取”，更贴近文章主体，通常更适合做总结/要点提炼。

#### 强制输出（必须是 JSON）
`run_ai` 的返回值 **必须且只能** 是以下 JSON envelope（不得夹带额外文本）：

```ts
type RunAIOutput =
  | { status: "ok"; result: any }
  | { status: "error"; reason: string };
```

- `status:"ok"` 必须包含 `result`
- `status:"error"` 必须包含 `reason`
- 若提供了 `schema`，则当 `status:"ok"` 时执行器必须校验 `result` 符合 `schema`：
  - 不符合则视为该 step 执行失败（建议将 reason 写为 “result schema validation failed: ...”）

#### 与 StepResult 的关系（重要）
`run_ai` 中的 `RunAIOutput` 是 **模型输出协议**（envelope），不是执行器对 step 的统一返回格式。
执行器必须将其映射为统一的 `StepResult`：
- 当模型输出 `{status:"ok", result:X}`：本 step 返回 `{status:"done", value:X}`
- 当模型输出 `{status:"error", reason:R}`：本 step 返回 `{status:"failed", reason:R}`
- 当 `schema` 校验失败：本 step 也应返回 `failed`（reason 写明校验失败原因）

因此，在 Flow 的插值与 `saveAs` 中，读取该步结果应使用 `${result.value}`（或旧模式 `saveAs:"x"` 等价于保存 `result.value`），不要引用 `${result}` 或 `${result.result}`。

> 备注：`run_ai` 的“结果约束说明”（只输出 JSON envelope、字段名固定等）由规范统一约束，Flow 中不需要传 `system` / `temperature` / `maxTokens` 等实现细节参数。


### 6.1.3 readPage（读取页面材料）

`readPage` 用于**显式**读取当前页面的基础材料（URL、标题、可见 HTML、文章抽取、视口截图），常用于：
- 将页面材料保存到 `vars` 供后续多步复用/分支判断
- 为 `run_ai` 或其它 action 准备更明确、可调试的输入
- 在不希望 `run_ai` 自动注入 page 材料的场景中，先读取再显式传入

> 注意：本版本不要求修改 `run_ai`；`readPage` 是可选工具，用于减少“隐式注入”带来的不确定性，但不会强迫 AI 额外生成步骤。

**Action**
```ts
{ type:"readPage"; field: FieldSpec }
```

**FieldSpec**
- 单项读取：`field` 为字符串（`"url"|"title"|"html"|"article"|"screenshot"`）
  - step.result **直接返回**该项值
- 多项读取：`field` 为对象（如 `{url:true, article:true}`）
  - step.result 返回对象，仅包含请求为 `true` 的键（未请求的键不出现）

```ts
type FieldSpec =
  | "html" | "url" | "title" | "article" | "screenshot"
  | { url?: boolean; title?: boolean; html?: boolean; article?: boolean; screenshot?: boolean }
```

**字段语义**
- `url`: 当前页面 URL（string）
- `title`: `document.title`（string）
- `html`: **可见区域**（清洗 + 裁剪后的 HTML）（string）
- `screenshot`: **viewport** 截图 DataURL（string，通常为 `data:image/png;base64,...`）
- `article`: 文章抽取结果（`object | string`）
  - `object`: Readability 等抽取的文章对象（字段可能包含但不限于 `title/byline/excerpt/contentHtml/contentText/contentMarkdown` 等；仅以实现返回为准）
  - `string`: 直接为页面内容的 Markdown 文本（若实现选择以 markdown 形式返回）

**失败策略（建议约定）**
- 任一请求项读取失败：该 step 视为 `failed`，并在 `result.reason` 中给出简洁原因（例如 `article extraction failed` / `screenshot capture failed`）。

**示例**
- 读取单项 URL：
```json
{ "id":"r1", "action": { "type":"readPage", "field":"url" } }
```

- 读取多项（url + article + screenshot）：
```json
{ "id":"r2", "action": { "type":"readPage", "field": { "url": true, "article": true, "screenshot": true } } }
```

### 6.1.5 ask_assist（请求人工介入）

`ask_assist` 用于登录、验证码、人机验证、人工确认等需要用户参与的场景。

#### 字段
- `reason: string`：提示给用户的原因/操作指引（支持插值）
- `waitUserAction?: boolean`（默认 `true`）：
  - `true`：弹出可确认/取消的 in-page prompt，流程等待用户操作完成
  - `false`：显示非阻塞 in-page tip，不阻塞后续 step
- `persistAcrossNav?: boolean`（默认由执行器决定，建议 `true`）：提示是否在跳转/刷新后自动恢复
- `persistTtlMs?: number`：跨跳转恢复的总生存时间（毫秒）
- `reopenDelayMs?: number`：仅对 `waitUserAction:true` 生效；页面稳定后重开 prompt 的延迟（毫秒）
- `tipPollMs?: number`：仅对 `waitUserAction:false` 生效；tip 存活检测轮询间隔（毫秒）
- `tipTimeoutMs?: number`：仅对 `waitUserAction:false` 生效；tip 自动关闭时间（毫秒）

#### 语义建议
- `waitUserAction:true`：
  - 用户确认后 step 返回 `done`
  - 用户取消/放弃后 step 返回 `failed`（`reason` 建议包含 `user cancelled`）
- `waitUserAction:false`：
  - step 立即返回 `done`，仅用于“告知进行中状态”
  - 若启用了持久化，执行器应在跳转/刷新后按 TTL 尝试恢复 tip

#### 示例
```json
{
  "type": "ask_assist",
  "reason": "请完成登录后点击“继续”",
  "waitUserAction": true,
  "persistAcrossNav": true,
  "persistTtlMs": 120000,
  "reopenDelayMs": 180
}
```

### 6.2.1 设计目标
- 只读：仅读取 `call.args`
- 不触碰页面：不做 WebDriver/DOM 操作
- 不执行代码：不支持 JS 表达式，不用 `new Function`
- 多分支：case/when/default
- 可静态校验：path 可用 Flow.args 声明做校验（可选实现）

### 6.2.2 BranchAction
```ts
type BranchAction = {
  type: "branch";
  cases: Array<{ when: Cond; to: string }>;
  default: string;
};
```

- `cases` 按顺序匹配，命中第一条即跳转
- 若都不命中，跳转 `default`

> 建议：`branch` step **不写 next**（branch 本身决定下一步）。

---

## 6.3 Cond DSL（安全条件表达，禁止 JS）
```ts
type Cond =
  // source：读取来源（默认 "args"）
  // - args:  从 call.args 读取（业务参数）
  // - opts:  从 call.opts 读取（运行策略/环境参数；若 opts 为 null 则视为不存在）
  // - result:从“上一步 action 执行结果”读取（由执行器提供的 result 对象；见 6.3.1）
  | { op: "exists";   path: string; source?: "args"|"opts"|"vars"|"result" }            // 值存在且非 null/undefined
  | { op: "truthy";   path: string; source?: "args"|"opts"|"vars"|"result" }            // JS truthy（非空字符串/非0/true/非空数组等）
  | { op: "eq";       path: string; value: any; source?: "args"|"opts"|"vars"|"result" } // ===
  | { op: "neq";      path: string; value: any; source?: "args"|"opts"|"vars"|"result" } // !==
  | { op: "gt";       path: string; value: number; source?: "args"|"opts"|"vars"|"result" } // 数值 >
  | { op: "gte";      path: string; value: number; source?: "args"|"opts"|"vars"|"result" } // 数值 >=
  | { op: "lt";       path: string; value: number; source?: "args"|"opts"|"vars"|"result" } // 数值 <
  | { op: "lte";      path: string; value: number; source?: "args"|"opts"|"vars"|"result" } // 数值 <=
  | { op: "in";       path: string; values: any[]; source?: "args"|"opts"|"vars"|"result" } // 值属于集合
  | { op: "contains"; path: string; value: any; source?: "args"|"opts"|"vars"|"result" }    // 字符串/数组包含（实现需区分类型）
  | { op: "match";    path: string; regex: string; flags?: string; source?: "args"|"opts"|"vars"|"result" } // 正则（可选）
  | { op: "and"; items: Cond[] }
  | { op: "or";  items: Cond[] }
  | { op: "not"; item: Cond };
```

- `path` 总是从 `call.args` 读取（例如 `"cover.data"` 表示 `call.args.cover.data`）
- `value/values/regex` 为常量（通常无需插值）
- `gt/gte/lt/lte` 按“数值比较”执行：运行时会把两侧转换为 Number；任一侧无法转换为有限数值（NaN/Infinity）则该条件视为不命中（false）

示例（有封面则上传，否则跳过）：
```js
{
  id: "routeCover",
  desc: "根据 args.cover 决定是否上传封面",
  action: {
    type: "branch",
    cases: [
      { when: { op: "exists", path: "cover.data" }, to: "uploadCover" }
    ],
    default: "skipCover"
  }
}
```

示例（publish 模式）：
```js
{
  id: "routePublish",
  desc: "根据 publish 参数决定是否发送",
  action: {
    type: "branch",
    cases: [
      { when: { op: "truthy", path: "publish" }, to: "clickSend" }
    ],
    default: "doneDraft"
  }
}
```

---



---

### 6.1.3a readElement（读取元素材料）

`readElement` 用于在 **currentPage** 中定位元素，并读取该元素的**一种**材料（文本 / value / HTML / rect / 指定属性），常用于：

- 读取 `<input>/<textarea>` 的当前 `value`（HTML 往往无法直接得知已填内容）
- 读取提示文案/按钮文案/错误信息的可见文本，用于分支判断
- 读取链接/图片等元素的关键属性（如 `href`/`src`/`aria-label`）
- 将“局部、结构化、可调试”的材料保存到 `vars`，供后续 `branch/run_ai` 使用

> 约定：`readElement` 只读取 **currentPage**；不支持 `scope/autoSwitch`（需要跨页/新页读取时，应先通过其它步骤把 `currentPage` 切换到目标页）。

#### Action

```ts
type ReadElementPick =
  | "text"               // 元素可见文本（建议 normalize-space）
  | "value"              // input/textarea.value；contenteditable best-effort
  | "rect"               // getBoundingClientRect()
  | "html"               // outerHTML（默认，包含元素自身标签与属性）
  | "html:inner"         // innerHTML（仅元素内部子树）
  | `attr:${string}`;    // 指定属性，例如 "attr:href" / "attr:src" / "attr:aria-label"

type ReadElementAction = {
  type: "readElement";
  query: string;
  by?: string;           // "css: ..." | "xpath: ..."
  pick: ReadElementPick; // 每次只能读取一种
  multi?: boolean;       // 默认 false：期望唯一；true：允许多项
};
```

#### by 格式（沿用 v0.34）
- CSS：`css: <标准 CSS selector>`
- XPath：`xpath: <XPath 表达式>`

> 说明：缺省 `by` 时，执行器会将 `query -> by`（与 click/wait/selector 一致）。若 `query` 含任何未转义的 `${`，建议不要固化 query→by（与 click 的注释保持一致），避免把带变量的 query 误固化为某个静态 by。

#### 返回值（StepResult.value）

- `multi !== true`（默认：期望唯一）
  - 命中 **恰好 1 个**：`status:"done"`，`value` 为“单值”
  - 命中 **0 或 >1 个**：`status:"failed"`，`reason` 写明原因；建议在 `meta.count` 回填命中数量

- `multi === true`（允许多选）
  - 命中 ≥ 1：`status:"done"`，`value` 为“数组值”（由单值组成），建议 `meta.count = value.length`
  - 命中 0：建议 `status:"failed"`（更利于分支判断）

`value` 的“单值”类型随 `pick` 不同而变化：

| pick | value（单值） |
|---|---|
| `"text"` | `string` |
| `"value"` | `string` |
| `"html"` / `"html:inner"` | `string`（建议限长裁剪；若裁剪，`meta.truncated=true`） |
| `"rect"` | `{ x:number; y:number; width:number; height:number; top:number; left:number; bottom:number; right:number }` |
| ``attr:${name}`` | `string \| null`（属性不存在返回 null） |

> 建议：只要动作涉及元素定位，执行器可在 `result.by` 回填最终使用/解析出的 `by`，便于调试与复现。

#### 示例

读取输入框 value（唯一）：
```json
{
  "id": "readTitleValue",
  "action": {
    "type": "readElement",
    "query": "标题输入框",
    "pick": "value"
  },
  "saveAs": "titleValue"
}
```

读取 CTA 链接的 href（唯一）：
```json
{
  "id": "readCtaHref",
  "action": {
    "type": "readElement",
    "by": "css: a[data-testid='cta']",
    "pick": "attr:href"
  },
  "saveAs": "ctaHref"
}
```

多选读取列表项文本：
```json
{
  "id": "readAllTags",
  "action": {
    "type": "readElement",
    "query": "标签列表里的每一个 tag 文本",
    "pick": "text",
    "multi": true
  },
  "saveAs": "tags"
}
```


---

### 6.1.3b setChecked（设置勾选状态）

`setChecked` 用于在 **currentPage** 中定位 checkbox / radio / 开关类控件，并将其设置到指定的 `checked` 状态。

设计目标：
- **幂等**：目标是“最终状态 = checked”，而不是“点击一次”
- **带验证**：执行后必须再次读取状态确认；否则返回 failed
- **best-effort 支持自定义开关**：对非原生控件尽量通过 `aria-checked` / `role="switch"` 等判断与验证

> 约定：`setChecked` 只作用于 **currentPage**；不支持 `scope/autoSwitch`。

#### Action

```ts
type SetCheckedAction = {
  type: "setChecked";
  query: string;
  by?: string;        // "css: ..." | "xpath: ..."
  checked: boolean;   // 目标状态
  multi?: boolean;    // 默认 false：期望唯一；true：对所有命中元素执行
};
```

#### 执行语义（推荐）

1) 定位目标元素（缺省 `by` 时执行器会将 `query -> by`）。
2) 获取当前状态 `cur`：
   - 原生 `<input type="checkbox">` / `<input type="radio">`：读取 DOM `checked`
   - 自定义开关：best-effort（例如 `aria-checked="true/false"`，或其它可稳定判断的状态）
3) 若 `cur === checked`：不点击，直接 `done`（`changed:false`）。
4) 否则执行一次“切换动作”（通常为 click），再读取并验证：
   - 若验证后 `cur2 === checked`：`done`（`changed:true`）
   - 否则：`failed`（reason 建议为 `state not changed`）

> Radio 注意：对 radio，`checked:false` 通常没有意义（无法“取消选中”而不选其它项）。实现可选择：
> - 若 `checked:false`：直接 `failed`（reason: `radio cannot be unchecked`）
> - 或视为 no-op（不建议，容易掩盖问题）

#### 返回值（StepResult.value）

- `multi !== true`：
  - `value: { checked: boolean; changed: boolean }`
- `multi === true`：
  - `value: Array<{ checked: boolean; changed: boolean }>`
  - 建议 `meta.count = value.length`

失败时建议：
- `meta.count` 回填命中数量（若可得）
- `reason` 使用可诊断短语：`not found` / `multiple matches: N` / `disabled` / `cannot determine checked state` / `state not changed`

#### 示例

```json
{
  "id": "enableSync",
  "action": {
    "type": "setChecked",
    "query": "同步到云端开关",
    "checked": true
  }
}
```

---

### 6.1.3c setSelect（设置下拉选择器选项）

`setSelect` 用于在 **currentPage** 中定位一个选择器（原生 `<select>` 或常见自定义下拉/combobox），并将其设置到指定选项。

设计目标：
- **幂等**：目标是“最终选中 = 指定选项”
- **带验证**：设置后应能验证所选项确已生效
- 原生 `<select>`：强保证
- 自定义控件：best-effort（通常为“点击展开 → 选择 option → 验证显示值变化”）

> 约定：`setSelect` 只作用于 **currentPage**；不支持 `scope/autoSwitch`。

#### Action

```ts
type SetSelectChoice =
  | { by: "value"; value: string }
  | { by: "label"; label: string }
  | { by: "index"; index: number };

type SetSelectAction = {
  type: "setSelect";
  query: string;
  by?: string;               // "css: ..." | "xpath: ..."
  choice: SetSelectChoice;   // 三选一
};
```

#### 执行语义（推荐）

1) 定位目标元素（缺省 `by` 时执行器会将 `query -> by`）。
2) 若目标是原生 `<select>`：
   - 按 `choice` 选择对应 `<option>`（value/label/index）
   - 触发必要的 `input/change`（实现自行稳定化）
   - 验证 `select.value` 或选中项 label 与期望一致
3) 若目标为自定义下拉/combobox（best-effort）：
   - 点击打开下拉
   - 定位并点击目标 option（按 label/value 的可用线索）
   - 验证控件显示值或内部状态变化（实现自行稳定化）
4) 若发现当前已是目标选项：不操作，直接 `done`（`changed:false`）。

#### 返回值（StepResult.value）

```ts
type SetSelectValue = {
  changed: boolean;
  selected?: { value?: string; label?: string; index?: number };
};
```

失败时建议：
- `reason`: `not found` / `multiple matches` / `option not found` / `disabled` / `open dropdown failed` / `selection not changed`
- 可在 `meta` 回填诊断信息（例如实际选中值）

#### 示例（按 value 选）

```json
{
  "id": "setLang",
  "action": {
    "type": "setSelect",
    "query": "语言选择",
    "choice": { "by": "value", "value": "zh-TW" }
  }
}
```

#### 示例（按 label 选）

```json
{
  "id": "setVisibility",
  "action": {
    "type": "setSelect",
    "query": "可见范围",
    "choice": { "by": "label", "label": "仅自己可见" }
  }
}
```

### 6.1.4 多页面（tabs/windows）与 scope / autoSwitch（selector & wait）

很多站点的点击会打开新页面（新 tab/window）。执行器需要维护“当前目标页面”（currentPage），并在跨页面探测/等待时可选择自动切换。

#### 运行时页面模型（执行器约定）
- 执行器维护 `pages: Page[]`：**仅包含仍然存活（未关闭）的页面**，并按“创建顺序” append（新页面 push 到末尾；页面关闭则从数组移除）。
- 执行器维护 `currentPage`：默认情况下，所有不带 scope 的动作都作用于 `currentPage`。
- `newestPage` 定义：若 `pages.length > 0`，则 `newestPage = pages[pages.length - 1]`；否则不存在。

#### scope 的精确定义（selector/wait）
- `scope:"current"`（默认）：仅在 `currentPage` 上探测/等待。
- `scope:"newest"`：仅在 `newestPage` 上探测/等待。
- `scope:"any"`：在 `pages` 中进行探测/等待。推荐顺序为：`newestPage → currentPage → 其它页面（从新到旧）`，以匹配“可能新开页面”的常见直觉。

> 注：同一页面内的导航（URL 变化）不产生新 page；只有真正创建了新的 tab/window 才会 append 到 `pages`。

#### autoSwitch（selector/wait 的命中后切页开关）
`selector` 与 `wait` 增加可选参数：
- `autoSwitch?: boolean`，默认 `true`

当 `scope` 为 `newest/any` 且命中发生在 `matchedPage != currentPage` 时：
- 若 `autoSwitch !== false`：执行器将 `currentPage` 切换为 `matchedPage`（使后续动作自然作用在命中页面上）。
- 若 `autoSwitch === false`：执行器不改变 `currentPage`。

当 `scope:"current"` 时，`autoSwitch` 无意义（命中页必为 current）。

#### 返回值约定：result.value 必带 page（并建议带 matchedPage）
为提升可观测性与便于后续步骤引用，`selector` 与 `wait` 在返回时应满足：
- 无论是否发生切页，`result.value.page` 必须存在：表示**该 step 执行结束后的 currentPage** 信息。
- 若该 step 成功命中（`status:"done"`），则 `result.value.matchedPage` 必须存在：表示**本次命中发生的页面**信息。

建议 `page/matchedPage` 的结构：
```ts
type PageInfo = {
  id: string;       // 执行器内部 pageId / browsingContextId（必填）
  url?: string;     // 可选：当执行器可获得时回填
  title?: string;   // 可选：当执行器可获得时回填
};
```

说明：
- 若 `autoSwitch:true` 且命中发生在新页面，则通常 `value.page.id === value.matchedPage.id`（因为已切换 currentPage）。
- 若 `autoSwitch:false` 且命中发生在非 current 页面，则 `value.page.id != value.matchedPage.id`（便于分支/调试）。
- 对 `wait`：超时应返回 `status:"timeout"`，此时通常不返回 `matchedPage`。


## 7. Action Union（Flow 执行层，带重要注释）

> 说明：本节中所有 `query: string` 字段，均兼容 `query: QuerySpec`（见 5.1.1）。示例为兼容旧写法，仍以 string 展示。
> 同时，`query` / `by` 允许写成数组（tuple）（见 5.3），用于同一 action 多定位输入。

```ts
type ActionBase = {
  // 动作成功（status=done）后，进入 next 前额外等待 N ms（默认 0）
  // 用途：给页面/组件状态一个短暂稳定期（例如 Enter 提交后 200~500ms）
  // 约束：仅作为“稳定期缓冲”，不能替代 wait 的条件等待
  // 建议：0~5000；负数按 0 处理
  postWaitMs?: number;
};

type Action = ActionBase & (
  // 打开指定 URL（url 支持插值：`${path}` 或 `${{ ... }}`；例如 `${targetUrl}`）
  // newPage=true 时：先创建新 tab/page，再在新页执行 goto（默认 false）
  | { type: "goto"; url: string; newPage?: boolean }

  // 关闭页面：
  // - target=active: 关闭 currentPage（默认）
  // - target=flow: 关闭当前 flow 使用/打开过的全部页面
  // - target=contextId: 按页面 id 关闭指定页（需 contextId）
  // - target=urlMatch: 关闭 URL 包含 matchUrl 的页面
  // ifLast:
  // - skip(默认): 若命中页是最后一页，则跳过
  // - fail: 若命中页是最后一页，则失败
  // - allow: 允许关闭最后一页
  // activateAfterClose=true(默认): 关闭后激活剩余页面作为 currentPage
  | {
      type: "closePage";
      target?: "active" | "flow" | "contextId" | "urlMatch";
      contextId?: string;
      matchUrl?: string;
      ifLast?: "skip" | "fail" | "allow";
      activateAfterClose?: boolean;
    }

  // 参数分支（仅根据 call.args 路由；不触碰页面）
  | BranchAction

  // 点击元素（query 支持插值：`${path}` 或 `${{ ... }}`；但若含任何未转义的 `${`，则不固化 query→by）
  // expectInputFocus=true 时，点击后必须确认已聚焦输入元素（适用于 click 后接 input 的场景）
  | { type: "click"; query: string; intent?: "open" | "dismiss" | "submit"; by?: string; pick?: number | string; expectInputFocus?: boolean }

  // 悬停到元素上（用于 hover 菜单/按钮显现）
  | { type: "hover"; query: string; by?: string; pick?: number | string }

  // ✅ 向当前焦点输入（必须先 click 激活；不负责定位）
  // mode:
  // - fill: 清空后输入
  // - type: 按键逐字输入（较慢、更“像人”）
  // - paste: 粘贴输入（适合长文本）
  // pressEnter: 输入完成后按 Enter（用于搜索/发送/提交等）
  // text 支持插值：`${title}` / `${body}` 或 `${{ ... }}`
  // clear: 若为 true，则输入前先清空当前焦点（建议长文本覆盖时配合 mode:"paste"）
  | { type: "input"; text: string; mode?: "fill" | "type" | "paste"; clear?: boolean; pressEnter?: boolean }

  // ✅ 纯按键交互（不定位，不点击）：Esc/Tab/箭头/快捷键等
  // - key: KeyboardEvent.key（例如 "Enter","Escape","Tab","ArrowDown"," "）
  // - modifiers: 修饰键（Control/Meta/Shift/Alt）
  // - times: 重复次数（默认 1），用于连续 Tab/连续 ArrowDown
  | { type: "press_key"; key: string; modifiers?: ("Shift"|"Alt"|"Control"|"Meta")[]; times?: number }

  // 滚动：按坐标滚动，或按元素滚动（仅滚动不点击）
  | { type: "scroll"; x?: number; y?: number; query?: string; by?: string }

  // 尝试滚动以让目标元素出现在视野中（本回合只做展示，不点击）
  | { type: "scroll_show"; query?: string; by?: string }

  // 读取页面材料（不等待、不交互）：url/title/html/article/screenshot
  // - field 为字符串时：step.result 直接返回对应值
  // - field 为对象时：step.result 返回对象，仅包含请求为 true 的键
  // - html: 可见区域（清洗 + 裁剪后的 HTML）
  // - screenshot: viewport 截图 DataURL（默认 data:image/png;base64,...）
  // - article: 文章抽取结果（object 或 markdown string，取决于实现）
  | {
      type: "readPage";
      field:
        | "html"
        | "url"
        | "title"
        | "article"
        | "screenshot"
        | { url?: boolean; title?: boolean; html?: boolean; article?: boolean; screenshot?: boolean };
    }

  // 读取元素材料（currentPage；每次只读一种；multi=true 返回数组 value）
  | {
      type: "readElement";
      query: string;
      by?: string;
      pick: "text" | "value" | "rect" | "html" | "html:inner" | `attr:${string}`;
      multi?: boolean;
    }

  // 设置勾选状态（currentPage；幂等；可选 multi 批量设置）
  | {
      type: "setChecked";
      query: string;
      by?: string;
      checked: boolean;
      multi?: boolean;
    }

  // 设置下拉选择器选项（currentPage；按 value/label/index；幂等）
  | {
      type: "setSelect";
      query: string;
      by?: string;
      choice:
        | { by: "value"; value: string }
        | { by: "label"; label: string }
        | { by: "index"; index: number };
    }



  // 处理系统对话框（alert/confirm/prompt）
  | {
      type: "dialog";
      op: "accept" | "dismiss";
      kind?: "alert" | "confirm" | "prompt";
      textContains?: string; // 可选：用于避免误处理不相关弹窗
      value?: string;        // prompt 的输入值（支持插值：`${otp}` 或 `${{ ... }}`）
    }
  // 上传文件：
// - 先定位上传入口（按钮或 input[type=file]），并上传一个或多个文件
// - 支持两种文件来源：
//   (A) 路径：files[i].path（推荐，最常见）
//       - 本机磁盘路径（绝对或相对）
//       - 内部索引路径：hub://...
//   (B) DataURL 内容：files[i].data（`data:<mime>;base64,...`），用于无磁盘/远程内容
// - files[i].filename 可选：
//     - 若给 path 且未写 filename：默认使用 path 的 basename；若为 hub://... 则优先用 Hub 元数据 filename
//     - 若给 data：强烈建议提供 filename
// - files[*].path / files[*].filename / files[*].data 均支持插值（`${path}` 或 `${{ ... }}`；默认从 call.args 取）
// - 约束：每个 FileSpec 必须且只能提供 path 或 data 之一（见 13. 约束）
| {
    type: "uploadFile";
    query: string;
    by?: string;
    files: Array<{
      path?: string;      // PathRef：本机磁盘路径 or hub://...（与 data 二选一）
      filename?: string;  // 可选，覆盖默认文件名
      data?: string;      // 可选，DataURL（与 path 二选一）
    }>;
  }



  // 在页面上下文运行一段“函数（允许形参）”，由执行器调用该函数并取返回值（用于轻量判断/提取）
  // ⚠️ code 约束非常严格：必须且只能是一个“函数（允许形参）”的代码（见 7.1）
  // ⚠️ code 不做插值（禁止在 code 中使用 ${...}）
  | { type: "run_js"; scope?: "page" | "agent"; code?: string; query?: string; args?: any[]; cache?: boolean }


  // 让 AI 做“总结/归纳/分类/结构化输出”（纯推理/纯变换；无页面交互/无网络/无副作用）
  // ⚠️ 强制输出 JSON envelope：{status:"ok",result} 或 {status:"error",reason}（不得夹带额外文本）
  // ⚠️ 可用 schema 约束 ok.result（JSON Schema；校验失败应视为该 step failed）
  | {
      type: "run_ai";
      prompt: string;
      input?: FlowVal | Array<{ name?: string; value: FlowVal }>;
      schema?: object;
      page?: { url?: boolean; html?: boolean; screenshot?: boolean };
      model?: "fast" | "balanced" | "quality" | "vision" | "free";
    }

  // 请求用户介入（登录/验证码/人机验证等）
  // - reason 支持插值：`${path}` 或 `${{ ... }}`（用于包含站点/账号/下一步提示）
  | {
      type: "ask_assist";
      reason: string;
      waitUserAction?: boolean;
      persistAcrossNav?: boolean;
      persistTtlMs?: number;
      reopenDelayMs?: number;
      tipPollMs?: number;
      tipTimeoutMs?: number;
    }

  // 探测/确认元素是否存在（不等待）：
  // - done = 找到（满足 state）
  // - failed = 没找到
  // - 常用于分支判断（例如“编辑器是否已打开”）
    | {
      type: "selector";
      query: string;
      state?: "present" | "visible";         // 默认 present
      scope?: "current" | "newest" | "any";   // 默认 current
      autoSwitch?: boolean;                   // 默认 true；当 scope 为 newest/any 且命中在非 current 页面时，是否切换 currentPage
      multi?: boolean;                        // 可选：是否期望多选（或必须唯一）；执行器据命中数量决定 done/failed，并在 result.meta.count 返回数量
      pick?: number | string;                 // 可选：命中多元素时二次选择（number 建议 1-based；-1 表示最后一个；string 表示文本包含）
      by?: string;
    }
  // 等待元素状态满足（会等待直到超时）：
  // - 默认等 visible/current
  // - scope:any 可用于“可能新开页面”的情况，但成功条件仍是“元素状态满足”
    | {
      type: "wait";
      query: string;
      state?: "visible" | "present" | "hidden" | "gone"; // 默认 visible
      scope?: "current" | "newest" | "any";               // 默认 current
      autoSwitch?: boolean;                                // 默认 true；当 scope 为 newest/any 且命中在非 current 页面时，是否切换 currentPage
      pick?: number | string;                              // 可选：命中多元素时二次选择（语义同 selector.pick）
      by?: string;
      timeoutMs?: number; // 建议 1200–2000
      pollMs?: number;    // 建议 100–250
    }

  // 调用其它 RPA agent/flow 子任务（如 blocker 清理、login、logoff 等）
  // - 优先使用 find（动态选择）
  // - invoke.args 内任意 string 值允许插值（`${path}` 或 `${{ ... }}`；默认从 call.args 取）
  // - 可选 invoke.fork：控制是否在 fork 的页面上下文中执行子 flow（见 8.1）
  | InvokeAction

  // 批量调用子任务（并发执行）
  // - items 为输入数组；每项可通过 itemVar/indexVar 注入模板参数
  // - 支持每项 fork（例如 fork 使用当前 item 的 URL）
  | InvokeManyAction

  // 任务完成：输出成功总结/答案
  | { type: "done"; reason: string; conclusion: string }

  // 放弃：仅当确定无法完成 goal
  | { type: "abort"; reason: string }
);
```

`pick` 约定（用于 click/hover/selector/wait）：
- `number`：建议 1-based；`-1` 表示最后一个；负数可扩展为倒数第 N 个。
- `string`：选择文本/可访问名称包含该字符串的第一个元素。
- 建议缓存“基础 selector”（列表级），`pick` 作为运行参数，不纳入 cache key。

> 注意：不再提供 `removeBlocker` action。请用 `invoke` 调用具备 `blockers.clear` 能力的子任务实现。

---

## 7.1 run_js 的强约束（必须遵守，重要）
`run_js.code` 必须满足：

- **必须且只能**是一段“函数定义”的代码（函数声明或函数字面量/箭头函数均可，**允许形参**）。
- **不得**包含任何非函数的顶层代码（变量赋值/表达式/立即执行等）。
- **不得**包含对该函数的调用代码（例如 `(... )()`、`fn()`、`return fn()` 等）。
- **不做插值**（禁止在 code 中使用 `${...}`）。
- **不得改变页面状态（v0.50 新增）**：`run_js` 仅用于 **提取/计算/生成内容/定位元素/校验页面状态**；禁止任何可能导致页面状态变化的行为（包括导航/跳转、DOM 写入、触发交互事件、网络请求、存储写入、计时器循环等；见 7.1.4）。



### 7.1.2 传参规则（run_js.args）
- 执行器会将 `action.args` 解析/插值后作为实参数组，并以 `fn(...args)` 的形式调用该函数。
- `action.args` 中的 string 值允许插值（`${path}` 或 `${{ ... }}`；例如 `${title}`、`${vars.post.url}`、`${result.value}`）。
- `code` 仍然不做插值（禁止在 code 内出现 `${...}`）。

**page scope 传参建议（强烈建议执行器实现限制）**
- `scope:"page"` 下，`action.args` 应要求为可序列化值（JSON/结构化克隆友好）。
- 建议对序列化后大小设上限（例如 64KB/256KB），超限则 `status:"failed"` 并给出 reason。
- 默认建议拒绝/限制 DataURL（尤其是大图片/视频）作为 page args，避免调用开销过大。


### 7.1.3 query/cache（AI 生成脚本与缓存）
- `run_js` 支持两种用法：
  1) **直接提供 `code`**：执行器按 `fn(...args)` 调用。
  2) **仅提供 `query`（不提供 code）**：执行器以 query 作为“脚本需求”，调用 AI 生成满足本规范的 `code`，再执行。
- `cache` 语义（布尔）：
  - `cache:true`：表示该脚本 **可能可复用**，允许执行器缓存/复用生成的 `code`（命中则跳过生成，提升速度）。
  - `cache:false` 或不写：明确 **不缓存**（每次新生成/新执行）。
  - 注意：`cache:true` 并不保证一定缓存；执行器可基于安全/大小/失败率等策略决定是否落盘。
- 缓存建议：
  - 缓存对象为 **query→code**（不缓存返回值）。
  - key 建议包含：`domainKey`、`scope`、规范化 `query`、以及 `specVersion`。
  - 若命中缓存 code 执行失败，执行器可自动 refresh 一次（重新生成 code 覆盖缓存）后再失败返回。
- AI 何时应设置 `cache:true`（经验准则）：
  - 适合缓存：纯 DOM 查询/状态判断/轻量提取；不依赖大体积动态参数；逻辑稳定且短小。
  - 不适合缓存：强依赖动态 args 内容（尤其长文本/DataURL）；依赖瞬时交互状态（hover/滚动位置）；选择器极脆弱。
允许示例（✅）：
```js
() => {
  return { title: document.title || "" };
}
```

也允许带形参（✅）：
```js
function(title, tags) {
  return { title, tagsCount: Array.isArray(tags) ? tags.length : 0 };
}
```

不允许示例（❌）：
```js
(() => { return 1 })()
```

执行器行为约定（推荐）：

### 7.1.1 scope 语义补充
- `scope:"page"`（默认）：函数在页面环境运行，可使用 `window/document/DOM` 做轻量判断或提取。
- `scope:"agent"`：函数在执行器/agent 环境运行，用于纯逻辑判断（例如基于 args/opts/上一步结果决定下一步）。
  - 仅允许读取只读上下文：`call.args`、`call.opts`、以及上一步 `result`（若执行器提供）。
  - 禁止产生副作用：禁止 WebDriver 调用、网络请求、文件 IO、计时器循环等。
  - 建议保持纯函数、可复现、无随机性。

### 7.1.4 不改变页面状态（只读）约束（v0.50 新增）

为保证 `run_js` **可纠错**（失败后可让 AI 改写并重试）与 **可缓存**（query→code 可复用），本规范将 `run_js` 明确限定为“只读探测/纯计算”动作：

#### 允许（✅）
`run_js` 可以做（但仍应保持短小、可重复）：
- **提取**：读取 DOM 文本/属性/结构、计数、可见性、URL/title 等（例如 `document.querySelectorAll(...)`、`getComputedStyle`、`getBoundingClientRect`、`textContent/innerText/value` *读取*）。
- **计算**：对已读取材料做归一化、打分、匹配、摘要（注意：涉及“理解/归纳/结构化输出”的任务优先用 `run_ai`）。
- **生成内容**：生成后续要用的文本/结构化对象（作为返回值），但**不写回页面**。
- **定位元素（只读）**：在页面中筛选候选元素，并返回可用于后续 action 的选择器字符串（例如返回 `"css: ..."` / `"xpath: ..."`），但**不点击/不聚焦/不滚动**。
- **校验页面状态**：例如“是否登录”“是否出现 paywall/验证码”“是否已进入编辑器”“是否有错误 toast”。

#### 禁止（❌，任何 scope 都禁止）
`run_js` **不得**包含或触发以下行为（包括直接调用或通过间接 API 触发）：
1) **导航/历史/窗口**
- `location = ...`、`location.assign/replace/reload(...)`
- `history.pushState/replaceState/go/back/forward(...)`
- `window.open(...)`

2) **DOM 写入 / 触发交互**
- `el.click()`、`el.focus()`、`el.blur()`、`form.submit()`
- `dispatchEvent(...)`（包括自定义事件与合成鼠标/键盘事件）
- 任何 DOM 写入：`innerHTML/outerHTML/insertAdjacentHTML/appendChild/removeChild/...`
- 任何属性/样式/类名写入：`setAttribute/removeAttribute`、`classList.add/remove/toggle`、`style.* = ...`、`el.value = ...`

3) **网络与外部副作用**
- `fetch`、`XMLHttpRequest`、`WebSocket`、`navigator.sendBeacon` 等
- 任何文件/系统 IO（仅 `scope:"agent"` 可能具备，但依然禁止）

4) **持久化写入**
- `localStorage.setItem/removeItem/clear`、`sessionStorage.*` 写入
- `indexedDB` 写入（建议连打开/升级也避免）

5) **计时器/循环等待（非确定性）**
- `setTimeout/setInterval/requestAnimationFrame`（以及基于它们的轮询/等待）
- busy loop 等

6) **弹窗**
- `alert/confirm/prompt`（与 `dialog` action 冲突，也会改变交互状态）

> 说明：模板字符串 `` `a${x}` `` 在表达力上等价于 `"a"+x`。但由于本规范将 `${...}` 作为插值语法的通用标记，`run_js.code` 仍要求 **不得出现** `${...}`（见 7.1）。

#### 执行器建议（强烈建议实现，便于纠错）
为确保只读约束能被可靠执行，建议执行器实现以下防护（至少选其一）：

- **静态扫描（推荐）**：对 `code` 做简单 token/关键词扫描，发现上述禁止 API 的明显调用即拒绝执行并 `failed`（reason 指出命中规则）。
- **运行时护栏（推荐）**：执行 `run_js` 前后记录关键环境（至少 `url` / `pageId` / `history.length`）；若执行后发生变化，则视为违反只读约束并失败返回（在 `result.meta` 中回填 before/after 以便 AI 纠错）。
- **隔离环境**：若实现成本允许，可在受限沙箱/Realm 中运行，屏蔽 `fetch/XMLHttpRequest/WebSocket` 等，并冻结敏感对象（例如 `location/history` 的写入接口）。


- 执行器会在页面中“定义并调用该无参函数”，获取返回值作为结果数据。
- 该函数应短小、可重复、无副作用，优先用于“判断/探测/轻量提取”。

---


### 7.2 run_ai 约定（执行器侧）

为保证可判定性与可编排性，执行器应遵循以下约定：

1) **只输出 JSON**  
   - 模型输出必须是纯 JSON（不允许前后夹带解释文本/Markdown）。  
   - 解析失败应视为该 step `failed`，并给出可诊断的 `reason`（例如 “invalid json output”）。

2) **输出 envelope 固定**  
   - 只允许：`{ status:"ok", result: ... }` 或 `{ status:"error", reason:"..." }`。  
   - 建议禁止额外字段（减少模型“夹带输出”造成的歧义）。

3) **映射为 StepResult（强制）**
   - 当模型输出 `{ status:"ok", result:X }`：执行器应将该步结果置为 `done`，并令 `StepResult.value = X`。
   - 当模型输出 `{ status:"error", reason:R }`：执行器应将该步结果置为 `failed`，并令 `StepResult.reason = R`。
   - 任何解析失败/非纯 JSON 输出：应将该步结果置为 `failed`，reason 建议为 “invalid json output”。
   - 说明：Flow 的插值与 `saveAs` 读取的是 `StepResult`，因此应使用 `${result.value}`。

4) **schema 校验**（当 action.schema 存在且 status=ok）  
   - 必须校验 `result` 符合 JSON Schema。  
   - 不符合时，建议将 step 置为 `failed`，reason 写明校验失败原因。

5) **page 注入**（当 action.page.* 为 true）  
   - `page.url:true`：注入当前 URL（例如 `location.href`）。  
   - `page.html:true`：注入 **visible + 清洗 + 裁剪后的 HTML**（推荐上限：若超出则裁剪并告知裁剪）。  
   - `page.screenshot:true`：注入 **viewport 截图**的 PNG DataURL（推荐限制边长与体积）。

6) **model 档位映射**  
   - `model` 是抽象档位，执行器可将其映射到内部可用的具体模型/资源池。  
   - 若指定档位不可用，执行器可降级到 `balanced`，并在日志中记录降级原因。



## 8. invoke 与 find（完整版）

### 8.1 InvokeAction 定义
```ts
type InvokeAction =
  | {
      type: "invoke";
      target: string;                    // 直接指定目标实现（可选）
      args?: Record<string, any>;         // 其中 string 值允许插值（`${path}` 或 `${{ ... }}`）
      fork?: boolean | string;            // false/不写=旧行为；true=在当前页 fork；string=打开该 URL 后 fork
      forkWait?: "none"|"interactive"|"complete"; // 仅 fork=string 时可选，默认 interactive
      timeoutMs?: number;
      onError?: "fail" | "return";        // 默认 fail
      returnTo?: "caller" | "keep";       // 默认 caller
    }
  | {
      type: "invoke";
      find: FindSpec;                    // 动态选择目标实现（推荐）
      args?: Record<string, any>;         // 其中 string 值允许插值（`${path}` 或 `${{ ... }}`）
      fork?: boolean | string;            // false/不写=旧行为；true=在当前页 fork；string=打开该 URL 后 fork
      forkWait?: "none"|"interactive"|"complete"; // 仅 fork=string 时可选，默认 interactive
      timeoutMs?: number;
      onError?: "fail" | "return";
      returnTo?: "caller" | "keep";
    };
```

```ts
type InvokeManyAction = {
  type: "invokeMany";
  // 二选一：固定 target 或动态 find
  target?: string;
  find?: FindSpec;

  // 批量输入
  items: any[];                          // 待处理项数组（可插值/表达式）
  concurrency?: number;                  // 并发上限（建议 1..8，默认 2）

  // 模板变量名（写入 vars，仅供本 action 的每项模板解析）
  itemVar?: string;                      // 默认 "item"
  indexVar?: string;                     // 默认 "itemIndex"（1-based）
  totalVar?: string;                     // 默认 "itemTotal"

  // 每项调用参数模板（其中 string 值允许插值）
  args?: Record<string, any>;

  // 每项调用控制（与 invoke 语义一致）
  fork?: boolean | string;               // 支持按 item 模板化
  forkWait?: "none"|"interactive"|"complete";
  itemTimeoutMs?: number;
  returnTo?: "caller" | "keep";          // 默认 caller

  // 错误策略
  continueOnError?: boolean;             // 默认 true；false=首个失败即失败
};
```

建议：
- `target` 与 `find` 二选一，避免歧义。
- 生成 Flow 时优先 `find`，让系统按能力/域名/成本等挑选最佳实现。

### 8.1.1 `invoke.fork` 语义（执行器约定）

- `fork` 缺省或 `false`：保持旧行为，在调用方当前 `webRpa/currentPage` 上执行子 flow。
- `fork: "<url>"`（非空字符串）：
  - 执行器应 fork 一个子 `webRpa`（独立 worker 页）；
  - 先在该 worker 页打开指定 URL（`forkWait` 控制等待策略，默认 `interactive`）；
  - 再执行子 flow；
  - 子 flow 结束后应回收 worker 页，不影响调用方当前页。
- `fork: true`：
  - 执行器应 fork 一个子 `webRpa`，但复用/借用调用方当前页作为子 flow 的执行页；
  - 子 flow 结束后不得关闭这张被借用的当前页（避免打断用户或主流程）；
  - 若子 flow 期间在 worker 中新开了额外页面，可按执行器策略清理。

与 `returnTo` 的关系：
- `returnTo:"caller"` 仍表示子 flow 完成后，调用方 `currentPage` 回到调用前页面；
- `fork=true` 时该页面本身未关闭，`returnTo:"caller"` 应自然成立。

---

### 8.1.2 `invokeMany` 语义（执行器约定）

- `invokeMany` 是对 `invoke` 的批量封装：对 `items[]` 的每一项执行一次子调用，并聚合结果。
- 每项模板解析时，执行器应提供以下局部变量：
  - `vars[itemVar]`（默认 `vars.item`）= 当前项
  - `vars[indexVar]`（默认 `vars.itemIndex`，1-based）= 当前序号
  - `vars[totalVar]`（默认 `vars.itemTotal`）= 总项数
- 每项可独立使用 `fork`（例如 `fork: "${vars.item}"` 表示以当前项 URL fork）。
- 返回值约定（建议执行器强制）：
  - `value.items[]`：每项必须包含  
    `{ index:number, item:any, ok:boolean, status:"done"|"failed", reason:string, value:any, error:string, invoke:{flowId:string,status:"done"|"failed",reason:string} }`
  - `value.meta`：`{ total:number, okCount:number, failCount:number, concurrency:number }`
- 错误策略：
  - `continueOnError=true`（默认）：单项失败不中断整体；
  - `continueOnError=false`：首个失败可终止并返回 `failed`。

---

### 8.2 FindSpec 定义
```ts
type FindSpec = {
  kind: string;                               // 例如 "rpa"
  must?: string[];                            // 必须具备的 capability key（cap/arg 一体化）
  prefer?: string[];                          // 加分项 capability key
  filter?: { key: string; value: string }[];  // 约束/适配范围（按 key/value 匹配）
  rank?: string;                              // 排序规则（受限，见 8.6）
};
```

---

### 8.3 capability key：cap/arg 一体化命名空间（重要）
- `must/prefer/filter.key` 中出现的字符串 **统一视为 capability key**。
- capability key 是一个 **单一命名空间**：cap 与 arg key 不区分层级，都可以作为 capability key 参与匹配/排序/过滤。
- AI **不得杜撰** capability key：必须来自提供的定义文件（如 `rpa.mjs`）。

---

### 8.4 filter 语义：AND / OR（重要）
`filter` 为数组 `{key,value}`：

- **不同 key 之间是 AND**
- **同一 key 的多条 value 之间是 OR**

示例：
```json
"filter": [
  {"key":"domain","value":"x.ai"},
  {"key":"domain","value":"*"},
  {"key":"locale","value":"zh-CN"}
]
```
含义：`domain ∈ {x.ai,*}` **且** `locale == zh-CN`。

---

### 8.5 filter 的匹配策略（推荐约定）
为避免“通配抢占”与“过度宽松”，推荐执行器遵循：

1) **严格匹配优先于通配**
- 同 key 多 value 时，优先匹配更具体的 value（如 `x.ai`）再考虑 `*`。

2) **只有包含 `*` 才算通用**
- 未声明 `domain:"*"` 的实现不应被当作“任意域通用”。

3) **校验 filter key 的合法性**
- 若 `filter.key` 不在定义文件声明范围内，执行器应报错或拒绝（推荐报错，避免 silent mismatch）。

> 上述是推荐约定；最终以你们执行器/定义文件里的规则为准。

---

### 8.6 rank：语法与限制（重要）
`rank` 用于在满足 `kind/must/filter` 的候选中排序。

#### 8.6.1 预置字段（优先）
推荐可用字段：
- `overallScore`, `quality`, `cost`, `speed`, `size`

#### 8.6.2 多级排序（逗号分隔）
```json
"rank": "cost,quality"
```
含义：先按 cost，再按 quality。

#### 8.6.3 针对某个 capability key 排序（尽量避免）
也可以写成某个 capability key 的排序键，但 **只有在注册时明确声明支持该排序键** 才可用。否则不可预期。
- 因此：生成 Flow 时尽量避免使用非预置 rank。
- 若无需强排序，可省略 `rank`（使用系统默认）。

---

### 8.7 生成 Flow 时的 find 推荐策略
- `must`：只放“真正必须”的能力（越少越稳）
- `prefer`：放加分项（例如“还能 login.check”）
- `filter`：优先给出目标域名 + 通配兜底
- `rank`：默认不写；必须写时优先预置字段（如 `"cost"`）

---

### 8.8 FindSpec 示例

#### 示例 1：清理 blocker，优先匹配 x.ai 域名
```json
{
  "kind": "rpa",
  "must": ["blockers.clear"],
  "prefer": ["login.check"],
  "filter": [
    { "key": "domain", "value": "x.ai" },
    { "key": "domain", "value": "*" }
  ],
  "rank": "cost"
}
```

#### 示例 2：只要能登录（不限定域名）
```json
{
  "kind": "rpa",
  "must": ["login.perform"],
  "filter": [
    { "key": "domain", "value": "*" }
  ]
}
```

#### 示例 3：多级排序（尽量少用）
```json
{
  "kind": "rpa",
  "must": ["post.publish"],
  "filter": [
    { "key": "domain", "value": "example.com" },
    { "key": "domain", "value": "*" }
  ],
  "rank": "cost,speed"
}
```

---

## 9. input 与 press_key 的使用建议（避免滥用）

### 9.1 输入与提交的推荐模式
- 通常：`click(激活)` → `input(text, mode=fill|type|paste, pressEnter?)`
- 回车/提交后若站点渲染有抖动，建议在该步加 `postWaitMs:200~500`，再进入 `wait`
- 仅当 UI 明显依赖键盘交互（Esc/Tab/箭头/快捷键）时使用 `press_key`

### 9.2 paste 适用场景
- 长文本（正文/邮件/帖子）优先 `mode:"paste"`，避免逐字输入慢且易触发站点限制
- 若站点限制剪贴板，可回退 `mode:"type"` 或 `mode:"fill"`

---

## 10. 推荐范式
- “参数分支”优先用：`branch`
- “存在性确认”用：`selector → 分支`
- “触发后等待变化”用：`click → wait → 分支`
- “输入并可能提交”用：`click → input(mode=paste, pressEnter?, postWaitMs?)`
- “纯按键交互”用：`press_key`
- “调用子能力”用：`invoke(find/target) → 分支`
- “query 含插值”时：不固化规则，交给 resolver/AI 每次重新选择

---

## 11. 生成 Flow 的硬性约束（给 AI）
1) `steps` 内字段顺序固定：`id, desc, action, next`
2) 只写原子动作；不要一步多动作
3) 需要输入：必须先 click 激活，再 input
4) 长文本优先 `input.mode="paste"`；若需要覆盖旧内容，优先 `input.clear=true + mode="paste"`（或旧写法 `mode="fill"` 仅适合短文本）
5) 需要提交/发送时可用 `input.pressEnter=true`，复杂快捷键用 `press_key`
6) 参数分支优先 `branch`，不要用 `run_js`/`router(function)` 代替
7) 存在性确认：用 selector，不要用 wait
8) 触发后等待：用 wait
9) 子能力调用：用 invoke（优先 find）
10) cap/arg/filter/rank key 必须来自提供的定义文件；禁止杜撰
11) `rank` 尽量不写；如需写仅用预置字段（overallScore/quality/cost/speed/size）
12) `filter`：同 key 多 value 为 OR；不同 key 为 AND；优先写具体域名 + `*` 兜底
13) `run_js.code` 必须且只能是函数（允许形参）代码；不得包含调用与顶层非函数代码；不做插值
13b) `run_js` 仅允许“只读探测/纯计算”：提取/计算/生成/定位/状态校验；禁止导航/DOM 写入/触发交互/网络/存储写入/计时器循环（见 7.1.4）
14) `uploadFile.files`：支持多文件；每个 FileSpec 必须且只能提供 `path` 或 `data` 之一；其中 `path` 支持本机磁盘路径与内部索引路径 `hub://...`；若提供 `data` 必须为 DataURL（`data:<mime>;base64,...`）；建议提供合理 `filename`（缺省且给本机 path 取 basename；hub://... 优先用 Hub 元数据 filename）
15) 插值仅允许 `${path}`（path 语法安全子集）；字面量 `${` 用 `\${` 转义
16) 若 `query` 含插值，则不得固化 query→by 记忆规则
17) `postWaitMs` 仅用于动作后短稳态；不能替代 `wait` 的条件等待
18) 需要“提交后缓冲”时，优先在触发动作上写 `postWaitMs:200~500`（例如 `input.pressEnter=true`）

---

## 变更记录
- v0.52：
  - `ask_assist` 新增 in-page 提示持久化参数：`persistAcrossNav` / `persistTtlMs` / `reopenDelayMs` / `tipPollMs` / `tipTimeoutMs`
  - 明确 `waitUserAction:true|false` 两种模式在 prompt/tip 下的行为语义与适用参数

- v0.51：
  - 新增 Action 通用参数 `postWaitMs?: number`（动作成功后进入下一步前的短暂稳定期；默认 0）

- v0.50：
  - `run_js` 新增“只读/不改变页面状态”约束（仅用于提取/计算/生成/定位/状态校验；禁止导航/DOM 变更/触发交互/网络/存储写入/计时器循环；见 7.1.4）

- v0.30：
  - `uploadFile.files[].path`：支持内部索引路径 `hub://...`（PathRef），执行器需可解析为实际二进制内容与元数据（filename/mime/size）。
- v0.29：
  - `uploadFile`：移除 `multi` 参数；是否多文件由 `files.length` 决定。保留 `files: FileSpec[]`（每项 `path` 或 `data` 二选一）语义。
- v0.9：
  - FindSpec 恢复完整说明（cap/arg 一体化、filter AND/OR、匹配策略、rank 多级与限制、示例）
  - 其余保持 v0.8 的完整内容与注释
