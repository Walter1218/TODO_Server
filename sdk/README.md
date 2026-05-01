# Agent TODO SDK

智能体任务管理 SDK，帮助 AI 智能体更好地管理任务上下文。

## 安装

```bash
# 直接在浏览器中使用
<script src="agent-todo-sdk.js"></script>

# 或在 Node.js 中使用
const AgentTODOSDK = require('./agent-todo-sdk.js');
```

## 快速开始

```javascript
// 初始化 SDK
const agentId = 'your-agent-id';
const todo = new AgentTODOSDK('http://localhost:3000', agentId);

// 创建任务
await todo.createTodo({
  title: '完成项目报告',
  priority: 'high',
  context: '这是Q2季度的核心交付物'
});

// 获取上下文摘要
const focus = await todo.focus();
console.log(focus.message);
```

## 核心功能

### 1. 任务管理

```javascript
// 创建任务
const task = await todo.createTodo({
  title: '撰写文档',
  description: '撰写API使用文档',
  priority: 'medium',
  context: '需要包含代码示例',
  tags: ['文档', 'API']
});

// 获取任务
const fetched = await todo.getTodo(task.data.id);

// 列出所有任务（支持筛选）
const all = await todo.listTodos({ status: 'pending', priority: 'high' });

// 更新任务
await todo.updateTodo(task.data.id, { status: 'in_progress' });

// 完成任务
await todo.completeTodo(task.data.id);

// 删除任务
await todo.deleteTodo(task.data.id);
```

### 2. 任务依赖

```javascript
// 添加依赖关系
await todo.addDependency('task-b-id', 'task-a-id');
// 现在 task-b 依赖于 task-a，只有 task-a 完成才能开始 task-b

// 移除依赖
await todo.removeDependency('task-b-id', 'task-a-id');

// 查看依赖树
const tree = await todo.getDependencyTree('task-b-id');
console.log(tree.data);
```

### 3. 项目管理

```javascript
// 创建项目
const project = await todo.createProject({
  name: '网站重构',
  description: '重构公司官网',
  color: '#3498db'
});

// 获取项目列表
const projects = await todo.listProjects();

// 更新项目
await todo.updateProject(project.data.id, { name: '新名称' });

// 删除项目
await todo.deleteProject(project.data.id);
```

### 4. 上下文聚焦（核心功能）

```javascript
// 获取完整的上下文摘要（推荐）
const focus = await todo.focus();
// 返回包含：
// - 当前任务概览
// - 智能建议
// - 优先任务列表
// - 被阻塞的任务
// - 正在进行中的任务
console.log(focus.message);

// 获取可执行任务（依赖都完成的任务）
const ready = await todo.getReadyTasks();

// 获取统计数据
const stats = await todo.getStats();
console.log(`紧急任务: ${stats.data.critical_pending}`);

// 搜索任务
const results = await todo.searchTodos('文档');
```

### 5. 便捷方法

```javascript
// 快速添加任务
await todo.quickAdd('完成报告', { priority: 'high' });

// 开始任务（更新状态为 in_progress）
await todo.startTask(taskId);

// 完成任务（更新状态为 completed）
await todo.doneTask(taskId);

// 规划任务链（自动设置依赖）
await todo.planTaskChain([
  { title: '调研', priority: 'high' },
  { title: '分析', priority: 'high', dependsOnPrevious: true },
  { title: '报告', priority: 'medium', dependsOnPrevious: true }
]);
```

## 使用场景

### 场景 1: 智能体启动时

```javascript
// 每次启动时调用，获取当前任务状态
const { summary, message } = await agentTodo.focus();

// 将摘要添加到系统提示词
const systemPrompt = `
你现在有一个任务管理助手帮你追踪任务。
当前状态：
${message}

请基于以上信息，合理安排你的工作。
`;
```

### 场景 2: 完成子任务后

```javascript
// 每次完成一个子任务后更新状态
await agentTodo.doneTask(subTaskId);

// 重新获取上下文，确保不偏离主线
const { summary } = await agentTodo.focus();
```

### 场景 3: 开始新任务前

```javascript
// 开始新任务前，检查是否有更高优先级的任务
const ready = await agentTodo.getReadyTasks();
const critical = ready.data.filter(t => t.priority === 'critical');

if (critical.length > 0) {
  console.log('⚠️ 有紧急任务未完成');
  // 自动选择最高优先级的任务
  return critical[0];
}
```

### 场景 4: 长时间任务后

```javascript
// 完成一个复杂任务后，查看是否有任务被阻塞
const { summary } = await agentTodo.focus();

if (summary.blocked > 0) {
  console.log('有被阻塞的任务，需要先完成依赖');
}
```

## API 端点参考

完整的 REST API 文档请访问: http://localhost:3000/

### 智能体 API
- `POST /api/agents` - 创建智能体
- `GET /api/agents/:id` - 获取智能体
- `GET /api/agents` - 列出所有智能体

### TODO API
- `POST /api/agents/:agentId/todos` - 创建任务
- `GET /api/agents/:agentId/todos` - 列出任务
- `GET /api/agents/:agentId/todos/summary` - 获取上下文摘要
- `GET /api/agents/:agentId/todos/ready` - 获取可执行任务
- `POST /api/agents/:agentId/todos/:id/dependencies` - 添加依赖

### 归档与清理 API
- `POST /api/agents/:agentId/todos/archive-old?days=30` - 归档旧任务
- `DELETE /api/agents/:agentId/todos/archived` - 物理删除已归档任务

### 项目 API
- `POST /api/agents/:agentId/projects` - 创建项目
- `GET /api/agents/:agentId/projects` - 列出项目

## 最佳实践

1. **定期调用 `focus()`** - 保持对任务上下文的清晰认知
2. **使用依赖关系** - 确保任务按正确顺序执行
3. **设置优先级** - 让智能体始终关注最重要的任务
4. **使用上下文字段** - 记录任务背景，防止遗忘
5. **使用标签** - 方便快速筛选和搜索任务
6. **定期清理** - 删除已完成的任务，保持列表简洁

## 示例代码

查看 `examples/usage-example.js` 获取完整的使用示例。

## License

MIT
