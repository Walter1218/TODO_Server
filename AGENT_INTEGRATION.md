# Agent 接入指南

帮助 AI Agent 快速接入 TODO Server，实现任务管理、聚焦引擎和多智能体协作。

---

## 🚀 快速开始

### 1. 初始化 SDK

```javascript
const AgentTODOSDK = require('./sdk/agent-todo-sdk');

const sdk = new AgentTODOSDK(
  'http://localhost:3000',  // TODO Server 地址
  'your-agent-id',          // Agent ID（从 TODO Server 注册获取）
  'your-secret-key'         // Secret Key（注册时返回）
);
```

### 2. 注册 Agent（首次使用）

```bash
curl -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent"}'

# 返回：
# {
#   "success": true,
#   "data": {
#     "id": "xxx",
#     "name": "my-agent",
#     "secret_key": "XXX..."    // <-- 保存这个！只返回一次
#   }
# }
```

### 3. 获取当前聚焦状态

```javascript
const { data } = await sdk.getFocus();
console.log('当前聚焦任务:', data?.task?.title || '无');

// 或让聚焦引擎自动选择最优任务
const result = await sdk.autoFocus();
console.log('自动聚焦到:', result.data.task.title);
```

---

## 📝 核心操作

### 任务管理

```javascript
// 快速创建
await sdk.quickAdd('完成季度报告', { priority: 'high' });

// 完整创建
await sdk.createTodo({
  title: '完成季度报告',
  description: 'Q2 季度数据汇总',
  priority: 'high',
  context: '需要包含销售数据和用户增长',
  tags: ['报告', 'Q2'],
  project_id: 'project-id'
});

// 更新状态
await sdk.updateStatus(taskId, 'in_progress');  // pending | in_progress | completed | cancelled | blocked

// 完成任务
await sdk.completeTodo(taskId);

// 删除任务
await sdk.deleteTodo(taskId);
```

### 依赖管理

```javascript
// 添加依赖（taskB 依赖 taskA）
await sdk.addDependency('task-b-id', 'task-a-id');

// 移除依赖
await sdk.removeDependency('task-b-id', 'task-a-id');

// 查看依赖树
const tree = await sdk.getDependencyTree('task-id');

// 创建任务链（自动设置依赖）
await sdk.planTaskChain([
  { title: '用户调研', priority: 'high' },
  { title: '需求分析', priority: 'high', dependsOnPrevious: true },
  { title: '产品设计', priority: 'high', dependsOnPrevious: true }
]);
// 自动形成: 调研 → 分析 → 设计
```

### 聚焦引擎

```javascript
// 获取当前聚焦（含任务详情 + 上下文摘要）
const { data } = await sdk.getFocus();

// 手动设置聚焦
await sdk.setFocus(taskId, {
  focusMode: 'manual',
  contextWindowSize: 10
});

// 自动聚焦（推荐：每次对话前调用）
const result = await sdk.autoFocus();
// 返回最优任务，已更新 focus_states 表
```

### 心跳追踪

在任务执行期间定期上报进度：

```javascript
await sdk.updateHeartbeat(taskId, {
  progress: 50,        // 0-100
  step: '编写数据层',   // 当前执行步骤
  blockers: ['等待API文档']  // 阻塞项（无则传空数组）
});
```

**心跳规则**：
- 建议每 5 分钟上报一次
- 超过 30 分钟无心跳 → 任务自动标记为 stuck
- 可通过 `getStuckTasks(30)` 查询卡住的任务

### 重试管理

```javascript
// 记录一次执行尝试
await sdk.recordAttempt(taskId, {
  success: false,
  result: '部分数据缺失',
  error: 'Database timeout'
});

// 超过 max_attempts（默认 3）→ 自动标记为 blocked
```

---

## 🤝 多智能体协作

### 指派任务给其他 Agent

```javascript
// 指派给 ops agent
await sdk.assignTask(taskId, 'hermes-ops', {
  note: '请部署到生产环境',
  preserveContext: false
});

// 被指派 agent 会收到通知
const notifications = await sdk.getNotifications(true); // true = 仅未读
```

### 转交任务

```javascript
// 转交给 coder agent（origin 保持不变，assigned 变更）
await sdk.transferTask(taskId, 'hermes-coder', {
  note: '需要代码审查',
  preserveContext: true
});
```

### 查询协作任务

```javascript
// 我创建的任务（origin_agent_id = me）
const created = await sdk.getCreatedTasks();

// 指派给我的任务（assigned_agent_id = me）
const assigned = await sdk.getAssignedTasks();

// 项目看板（跨 agent 统计）
const board = await sdk.getProjectBoard('project-id');
// 返回：按 agent 分组、总体进度、各 agent 任务数
```

### 通知管理

```javascript
// 获取通知（含指派、转交、完成等）
const notifications = await sdk.getNotifications(true); // 仅未读

// 标记已读
await sdk.markNotificationRead('notification-id');

// 全部已读
await sdk.markAllNotificationsRead();
```

---

## 💡 使用场景

### 场景 1：单 Agent 任务执行

```
用户：帮我写一个用户登录功能

1. Agent 创建任务
   await sdk.createTodo({
     title: '实现用户登录功能',
     priority: 'high',
     context: '用户要求实现登录功能'
   });

2. 生成验收标准（LLM 驱动）
   // Framework 自动调用 _generateAcceptanceCriteria()
   // 展示给用户确认

3. 用户确认后，开始执行
   await sdk.updateStatus(taskId, 'in_progress');
   await sdk.setFocus(taskId);

4. 执行期间定期心跳
   await sdk.updateHeartbeat(taskId, { progress: 30, step: '设计数据库表' });

5. 完成后请求确认
   // Framework 自动调用 _proposeTaskCompletion()
   // 用户回复「确认」后标记完成
   await sdk.completeTodo(taskId);
```

### 场景 2：多 Agent 协作

```
Default Agent：帮我完成用户系统

1. 创建父任务
   await sdk.createTodo({ title: '用户系统开发', priority: 'critical' });

2. 拆分子任务并指派
   const loginTask = await sdk.createTodo({ title: '登录功能', parent_id: parentId });
   await sdk.assignTask(loginTask.data.id, 'hermes-coder', { note: '使用 JWT' });

   const deployTask = await sdk.createTodo({ title: '部署到生产', parent_id: parentId });
   await sdk.assignTask(deployTask.data.id, 'hermes-ops', { note: 'Docker 部署' });

3. Coder Agent 完成后通知 Default
   // 自动发送 completed 通知

4. Ops Agent 部署完成后，父任务自动检测完成
   // 所有子任务 completed → 父任务 auto-completed
```

### 场景 3：工作汇报

```javascript
// 获取聚焦摘要（含统计、优先任务、阻塞项）
const { data } = await sdk.getFocus();

// 获取任务统计
const stats = await sdk.getStats();

// 获取卡住的任务
const stuck = await sdk.getStuckTasks(30);
```

---

## 🔐 认证说明

所有 Agent 级别的 API 需要 `X-Agent-Secret` Header：

```javascript
const sdk = new AgentTODOSDK(
  'http://localhost:3000',
  'agent-id',
  'secret-key'  // 注册时返回，只出现一次
);
```

**跨 Agent 操作**：
- 任何已知 Agent 的 secret key 可以访问其他 Agent 的资源
- 用于多智能体协作场景（如 A 指派任务给 B）

---

## 📚 完整 API 参考

### 任务管理

| 方法 | 说明 |
|------|------|
| `createTodo(options)` | 创建任务 |
| `getTodo(id)` | 获取单个任务 |
| `listTodos(filters)` | 列出任务（支持筛选） |
| `updateTodo(id, data)` | 更新任务 |
| `deleteTodo(id)` | 删除任务 |
| `completeTodo(id)` | 完成任务 |
| `updateStatus(id, status)` | 更新状态 |
| `addDependency(id, depId)` | 添加依赖 |
| `removeDependency(id, depId)` | 移除依赖 |
| `getDependencyTree(id)` | 获取依赖树 |
| `getSubtasks(id)` | 获取子任务 |
| `planTaskChain(tasks)` | 规划任务链 |
| `getReadyTasks()` | 获取可执行任务 |
| `getStats()` | 获取统计 |
| `searchTodos(query)` | 搜索任务 |

### 聚焦引擎

| 方法 | 说明 |
|------|------|
| `getFocus()` | 获取当前聚焦 |
| `setFocus(taskId, options)` | 手动设置聚焦 |
| `autoFocus()` | 自动聚焦 |

### 心跳与重试

| 方法 | 说明 |
|------|------|
| `updateHeartbeat(id, data)` | 更新心跳 |
| `recordAttempt(id, data)` | 记录尝试 |
| `getStuckTasks(maxIdleMinutes)` | 获取卡住的任务 |

### 多智能体协作

| 方法 | 说明 |
|------|------|
| `assignTask(id, targetAgentId, options)` | 指派任务 |
| `transferTask(id, targetAgentId, options)` | 转交任务 |
| `getAssignedTasks(filters)` | 指派给我的 |
| `getCreatedTasks(filters)` | 我创建的 |
| `getNotifications(unreadOnly)` | 获取通知 |
| `markNotificationRead(id)` | 标记已读 |
| `markAllNotificationsRead()` | 全部已读 |
| `getProjectBoard(projectId)` | 项目看板 |

### 上下文存储

| 方法 | 说明 |
|------|------|
| `saveContext(sessionId, role, content, metadata)` | 存储消息 |
| `getContexts(sessionId, limit)` | 查询消息 |
| `getSessionSummary(sessionId)` | 会话摘要 |

### 项目管理

| 方法 | 说明 |
|------|------|
| `createProject(options)` | 创建项目 |
| `getProject(id)` | 获取项目 |
| `listProjects()` | 列出项目 |
| `updateProject(id, data)` | 更新项目 |
| `deleteProject(id)` | 删除项目 |

### 便捷方法

| 方法 | 说明 |
|------|------|
| `quickAdd(title, options)` | 快速创建 |
| `startTask(id)` | 开始任务 |
| `doneTask(id)` | 完成任务 |
| `focus()` | 获取上下文摘要（格式化文本） |

---

## 🐍 Python SDK（Hermes Skill）

```bash
# 查看任务统计
python3 ~/.hermes/skills/hermes-todo-skill/todo_skill.py stats

# 自动聚焦
python3 ~/.hermes/skills/hermes-todo-skill/todo_skill.py auto-focus

# 创建任务
python3 ~/.hermes/skills/hermes-todo-skill/todo_skill.py create --title "新任务"

# 指派任务
python3 ~/.hermes/skills/hermes-todo-skill/todo_skill.py assign \
  --task-id <id> --target-agent hermes-ops --note "请处理"

# 查看通知
python3 ~/.hermes/skills/hermes-todo-skill/todo_skill.py notifications
```

**Profile 感知**：Skill 根据 `HERMES_HOME` 环境变量自动匹配 agent 凭证，无需手动指定。

---

## ⚠️ 注意事项

1. **每次对话前**调用 `autoFocus()` 获取当前最优任务
2. **任务执行期间**定期调用 `updateHeartbeat()` 避免被标记为 stuck
3. **完成重要任务后**及时调用 `doneTask()` 或 `completeTodo()`
4. **遇到阻塞**时检查是否有前置任务未完成，或上报 blockers
5. **跨 agent 指派**前确保目标 agent 已在 TODO Server 中注册
