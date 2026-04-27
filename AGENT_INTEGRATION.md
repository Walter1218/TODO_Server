# Agent接入指南

本文档帮助AI Agent快速接入和使用TODO任务管理服务。

## 🎯 快速开始

### 1. 初始化SDK

```javascript
const AgentTODOSDK = require('./sdk/agent-todo-sdk.js');

const todo = new AgentTODOSDK(
  'http://localhost:3000',  // TODO Server地址
  'your-agent-id'           // 你的Agent ID
);
```

### 2. 启动时获取任务状态

```javascript
// 每次启动时调用，获取当前任务状态
const { summary, message } = await todo.focus();

console.log(message);
// 输出示例：
// 📋 当前任务状态
// - 总任务: 5
// - 活跃任务: 3
// - 已完成: 2
// - 被阻塞: 0
//
// 🎯 优先任务:
// 1. [HIGH] 完成报告
// ...
```

## 📝 核心操作

### 创建任务

```javascript
// 快速创建
await todo.quickAdd('完成季度报告', { priority: 'high' });

// 完整创建
await todo.createTodo({
  title: '完成季度报告',
  description: 'Q2季度数据汇总',
  priority: 'high',        // critical/high/medium/low
  context: '需要包含销售数据和用户增长',
  tags: ['报告', 'Q2']
});
```

### 更新任务状态

```javascript
// 开始任务
await todo.startTask(taskId);  // 状态变为 in_progress

// 完成任务
await todo.doneTask(taskId);   // 状态变为 completed

// 更新任意字段
await todo.updateTodo(taskId, {
  status: 'in_progress',
  priority: 'critical'
});
```

### 设置任务依赖

```javascript
// 任务B必须在任务A完成后才能开始
await todo.addDependency('task-b-id', 'task-a-id');

// 创建任务链（自动设置依赖）
await todo.planTaskChain([
  { title: '用户调研', priority: 'high' },
  { title: '需求分析', priority: 'high', dependsOnPrevious: true },
  { title: '产品设计', priority: 'high', dependsOnPrevious: true }
]);
// 自动形成: 调研 → 分析 → 设计
```

## 🔍 查询任务

```javascript
// 获取可执行的任务（依赖已满足）
const ready = await todo.getReadyTasks();

// 获取统计数据
const stats = await todo.getStats();
console.log(`紧急任务: ${stats.data.critical_pending}`);

// 搜索任务
const results = await todo.searchTodos('报告');
```

## 💡 智能聚焦

当你不确定下一步该做什么时：

```javascript
const { summary, message } = await todo.focus();

// message 包含：
// - 当前任务概览
// - 智能建议
// - 优先任务列表
// - 被阻塞的任务

// 将摘要添加到你的思考中
console.log(message);
```

## 🎓 使用示例

### 示例1: 完成用户请求

```
用户：帮我写一个用户登录功能

1. 创建任务
   await todo.quickAdd('实现用户登录功能', { priority: 'high' });

2. 规划子任务
   await todo.planTaskChain([
     { title: '设计数据库表', priority: 'high' },
     { title: '编写登录API', priority: 'high', dependsOnPrevious: true },
     { title: '编写前端登录页', priority: 'medium', dependsOnPrevious: true },
     { title: '测试登录流程', priority: 'high', dependsOnPrevious: true }
   ]);

3. 开始执行第一个任务
   await todo.startTask(firstTaskId);
```

### 示例2: 工作汇报

```
用户：汇报一下当前进度

1. 获取任务摘要
   const { message } = await todo.focus();

2. 回复用户
   "当前进度：
   - 总任务: 10
   - 已完成: 6
   - 进行中: 2
   - 被阻塞: 1
   
   正在进行：
   - 实现用户登录API [80%]
   - 编写单元测试 [30%]
   
   阻塞任务：等待UI设计稿"
```

## ⚠️ 注意事项

1. **每次启动时**调用`focus()`获取最新状态
2. **完成重要任务后**及时调用`doneTask()`
3. **遇到阻塞**时检查是否有前置任务未完成
4. **长期任务**及时更新状态，避免任务"僵尸化"

## 🔗 完整API参考

| 方法 | 说明 |
|------|------|
| `quickAdd(title, options)` | 快速创建任务 |
| `createTodo(options)` | 完整创建任务 |
| `getTodo(id)` | 获取单个任务 |
| `listTodos(filters)` | 列出任务（支持筛选） |
| `updateTodo(id, data)` | 更新任务 |
| `deleteTodo(id)` | 删除任务 |
| `startTask(id)` | 开始任务 |
| `doneTask(id)` | 完成任务 |
| `addDependency(taskId, depId)` | 添加依赖 |
| `removeDependency(taskId, depId)` | 移除依赖 |
| `getReadyTasks()` | 获取可执行任务 |
| `getStats()` | 获取统计 |
| `searchTodos(query)` | 搜索任务 |
| `focus()` | 获取完整上下文摘要 |
| `planTaskChain(tasks)` | 规划任务链 |

## 🚀 配置

TODO Server默认地址：`http://localhost:3000`

如需修改，编辑`sdk/agent-todo-sdk.js`或传入不同地址：
```javascript
const todo = new AgentTODOSDK('http://your-server:3000', 'agent-id');
```
