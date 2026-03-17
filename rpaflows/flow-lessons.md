# Flow 编写经验教训（可复用清单）

## 1. 先确认运行前提，再写动作
- 先锁定执行上下文：是“已在目标页面内”还是“需要从 URL 打开”。
- 如果页面已打开且已有输入框，不要先 `goto`，直接走页面内交互链路。

## 2. `invoke` 的边界要清晰
- 业务能力实现本身不要“自调用”同能力。
- `invoke` 用来复用子能力（例如 `read.list`、`login`、`blockers.clear`）。

## 3. 搜索类 Flow 的推荐原子链路
- `click` 聚焦搜索框
- `input` 输入关键词（可 `pressEnter:true` 提交）
- `wait` 等待结果区域出现
- `invoke` 调 `read.list` 读取结果

## 4. 输入规范必须遵守
- `input` 前必须先有可验证的聚焦动作（通常是 `click`）。
- 长文本优先 `mode:"paste"`。
- 覆盖旧值优先 `clear:true`。

## 5. 结果读取优先标准能力，不要先写脆弱脚本
- 读取列表优先 `invoke + read.list`，不要默认用 `run_js` 抓 DOM。
- 这样更通用、可复用、也更容易被调度器统一治理。

## 6. capability/filter/rank key 必须来自定义文件
- `must/prefer/filter/read.*` 等 key 必须对齐 `rpa.mjs`。
- 不允许杜撰不存在的能力 key。

## 7. 对外可发现性要单独设计
- 在实现对象中显式暴露 `capabilities` 与 `filters`。
- 让外部 flow 能稳定通过 `invoke.find` 发现并调用。

## 8. 分支连线是高频错误点
- 修改 step id 后必须同步更新所有 `next` 指向。
- 每次改动后都做一次“step id 与 next 引用”自检。

## 9. `wait` 与 `selector` 职责分离
- 触发动作后等待状态变化：用 `wait`。
- 只做存在性探测分支：用 `selector`。

## 10. 开发策略：先通用正确，再做站点增强
- 先保证通用 flow 在主路径稳定。
- 再补站点特化 fallback（例如 X 的快捷键聚焦、特定容器 target）。

## 11. 当前项目可执行模板（搜索）
- 场景：Web RPA 已在站内页面。
- 推荐：`click(search input) -> input(query) -> wait(results) -> invoke(read.list)`。
- 输出：将 `read.list` 返回保存到 `vars.searchResult`，供后续步骤使用。
