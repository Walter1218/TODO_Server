# TODO Server Heartbeat 自动化方案设计

> 记录各方案的设计、优劣和待实现状态，供后续迭代参考。

---

## 已落地：方案 A — 对话保活心跳

### 触发时机
每次 Hermes 对话前调用 `_inject_todo_server_focus` 时，同步调用 `agent_todo heartbeat` 更新当前聚焦任务的 "last active" 时间戳。

### 实现位置
- `tools/agent_todo_tool.py` — 新增 `heartbeat` action
- `run_agent.py::_fetch_todo_server_focus` — 注入 focus 后自动调用 heartbeat

### 扩展（2026-04-28）
- **话题切换规则**：在注入的 Prompt 约束中增加四层切换策略（明确/疑似/继续/闲聊），让 LLM 自主判断用户意图优先级
- **blockers 支持**：`heartbeat` 支持传递 `blockers` 字段，用于标记任务被用户主动暂停

### 进度准确性
⭐ 低 — 只更新时间戳，不更新真实进度百分比和步骤。

### 优点
- 改动最小，不侵入 agent loop
- 解决 "30 分钟无心跳 → stuck" 的误判问题
- 不需要用户催促

### 缺点
- 进度数字不会自动推进
- 步骤描述不会自动更新
- 无法反映代码执行的真实状态

### 状态
✅ 已上线（2026-04-28）

---

## 已落地：方案 B — Tool 闭环心跳

### 触发时机
每次 Hermes 调用任意 tool 完成后（`agent_todo` 除外避免递归），如果当前有聚焦任务，自动把 tool 名称写入 heartbeat step 字段。

### 实现位置
- `run_agent.py::_invoke_tool_impl` — tool 执行后自动 heartbeat

### 进度准确性
⭐⭐ 中 — 能反映 "正在使用什么 tool"，但无法反映 tool 内部的真实进度。

### 优点
- 自动化程度高，不需要对话触发
- 能反映 agent 正在做什么

### 缺点
- 每次 tool 调用都上报，可能过于频繁
- 进度仍然不精确

### 实现思路
```python
# 在 tool 调用后的闭环中
if function_name != "agent_todo" and self._current_focus_task_id:
    agent_todo_tool(
        action="heartbeat",
        todo_id=self._current_focus_task_id,
        step=f"执行 tool: {function_name}",
    )
```

### 状态
✅ 已上线（2026-04-28）

---

## 待实现：方案 C — 代码执行 Hook 心跳

### 触发时机
长时间运行的 bash/python 脚本执行前后自动上报真实进度。

### 实现位置
- `run_agent.py` 的代码执行器（`_execute_bash` / `_execute_python` 或类似方法）

### 进度准确性
⭐⭐⭐ 高 — 能反映真实的执行阶段和耗时。

### 优点
- 进度最准确，能反映真实执行状态
- 适合长时间任务（如批量数据抓取）

### 缺点
- 侵入性最大，需要修改代码执行核心逻辑
- 需要 agent 在执行代码前 "预估" 总步骤，才能计算百分比
- 错误处理逻辑复杂（执行失败时如何上报 blocked）

### 实现思路
```python
def _execute_long_running_script(self, script, task_id):
    # 执行前
    agent_todo_tool(action="heartbeat", todo_id=task_id,
                    progress=0, step="开始执行脚本...")
    
    try:
        result = run_script(script)
        # 执行后
        agent_todo_tool(action="heartbeat", todo_id=task_id,
                        progress=100, step="脚本执行完成")
    except Exception as e:
        # 失败时上报 blocked
        agent_todo_tool(action="heartbeat", todo_id=task_id,
                        step=f"执行失败: {str(e)}")
```

### 状态
📋 待实现

---

## 已落地（变体）：方案 D — 服务端 stuck task 自动处理

### 触发时机
TODO Server 启动后内置定时器，每 5 分钟扫描所有 agent 的 `in_progress` 任务，超过 30 分钟无心跳自动标记为 `blocked`。

### 实现位置
- `src/server.js` — `StuckTaskMonitor` setInterval

### 与原始方案 D 的差异
原始方案 D 设想的是"刷假心跳保活"，实际实现改为"直接标记 blocked"，因为：
- 假心跳无法反映真实状态，反而掩盖问题
- 直接标记 `blocked` 更诚实，通知运维人员介入
- 无需额外进程，内嵌在 TODO Server 中

### 实现代码
```javascript
setInterval(() => {
  const agents = Agent.findAll();
  for (const agent of agents) {
    const stuck = Todo.findStuckTasks(agent.id, 30);
    for (const task of stuck) {
      Todo.updateStatus(agent.id, task.id, 'blocked');
    }
  }
}, 5 * 60 * 1000);
```

### 状态
✅ 已上线（2026-04-29）

---

## 已落地：方案 F — 旧任务自动归档（CleanupMonitor）

### 触发时机
TODO Server 启动后内置定时器，每天自动归档超过 30 天的 `completed`/`cancelled` 任务（软删除，`archived=1`）。

### 实现位置
- `src/server.js` — `CleanupMonitor` setInterval
- `src/models/Todo.js` — `archiveOldCompleted()`、`purgeArchived()`

### 优点
- 防止数据库无限膨胀
- `GET /todos` 默认排除已归档任务，查询性能不受影响
- 提供手动归档/物理清理 API 供运维使用

### 状态
✅ 已上线（2026-04-29）

---

## 已落地：方案 E — 自动聚焦推进（auto-switch）

### 触发时机
当 `_inject_todo_server_focus` 检测到当前聚焦任务已完成（`completed`/`cancelled`）或无聚焦任务时，自动调用 `/focus/auto` 选择下一个最优任务。

### 实现位置
- `tools/agent_todo_tool.py::agent_todo_focus` — 新增 `auto_switch` 参数
- `run_agent.py::_fetch_todo_server_focus` — 调用 `focus` 时启用 `auto_switch=True`

### 配合机制
- **话题切换规则**：Prompt 约束中明确告知 LLM — 用户即时意图优先于历史任务
- **blockers 标记**：用户切换话题时，LLM 调用 `heartbeat(blockers=[...])` 暂停当前任务
- **恢复规则**：用户提到历史任务关键词时，优先恢复而非创建新任务

### 状态
✅ 已上线（2026-04-28）

---

## 综合建议

| 阶段 | 推荐方案 | 说明 |
|------|---------|------|
| **当前** | A + B + E（已落地） | 对话保活 + tool 闭环 + 自动聚焦推进 |
| **中期** | C | 在长时间代码执行前后上报真实进度 |
| **兜底** | D | 独立守护进程作为最后保险 |

实际进度推进的核心瓶颈：**Hermes 不会自动将代码执行状态映射到 TODO Server 的进度字段。** 这需要 agent 在 prompt 层面被明确告知 "每完成一个阶段就调用 agent_todo heartbeat 更新进度"，或者通过更底层的 hook 自动上报。
