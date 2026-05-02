# Web UI 与 Agent 驱动架构融合方案

> 版本: 1.0
> 日期: 2026-05-02
> 状态: 🟡 部分实现

---

## 一、问题背景

### 架构演进

TODO Server 从"人类任务管理工具"演进为 **Agent Orchestrator**：

```
Phase 1 (人类为主)
  人类 → Web UI → TODO Server
  Hermes/Worker → HTTP API → TODO Server (少数)

Phase 2 (Agent 驱动)
  Hermes Agent → 结构化工具调用 → TODO Server (Orchestrator)
  OpenClaw Agent → 结构化工具调用 → TODO Server (Orchestrator)
  人类 → Web UI → 人类任务管理（与 Agent 任务隔离）
```

### 核心矛盾

| 场景 | 问题 |
|------|------|
| Hermes 正在执行任务 A | 人类在 Web UI 手动把 A 标记 completed |
| Agent 任务有 acceptance_criteria | Web UI 可以绕过 criteria 直接改状态 |
| Agent 汇报了 blockers | Web UI 不显示，人类看不到障碍 |
| Agent 调用 askForHelp | Web UI 没有专门的响应和处理界面 |

### 当前状态

- ✅ **P0-1**: API 层已支持 `source=agent\|human` 过滤
- ✅ **P0-2**: 任务列表增加 🤖 Agent 标识，详情页区分来源
- ✅ **P0-3**: Agent 任务已隐藏"强行驱动"按钮
- 🔴 **P0 后端保护**: 后端 API 未校验来源，禁止人类修改 Agent 任务
- 🔴 **P1 askForHelp**: 无人类响应机制
- 🔴 **P2 Agent 监控面板**: 无专门视图

---

## 二、目标架构

```
┌──────────────────────────────────────────────────────────────┐
│                    Web UI (Dashboard)                         │
├──────────────────┬───────────────────┬───────────────────────┤
│  [全部] [人类]    │  [Agent 任务]       │  [Agent 监控]         │
│   👤 人类任务     │   🤖 Agent 执行中   │   📡 实时状态          │
└──────────────────┴───────────────────┴───────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │     TODO Server (Orchestrator)  │
              │                                │
              │  • 人类任务: 完整 CRUD         │
              │  • Agent 任务: 只读 + 响应     │
              │  • askForHelp: 人类介入通道    │
              └───────────────────────────────┘
```

---

## 三、已实现功能 (P0)

### 3.1 API 层来源过滤

**文件**: `src/models/Todo.js`, `src/routes/todos.js`

```javascript
// Todo.findAllByAgent() 支持 source 参数
const todos = Todo.findAllByAgent(agentId, { source: 'agent' }); // 仅 Agent 任务
const todos = Todo.findAllByAgent(agentId, { source: 'human' }); // 仅人类任务

// 专用端点
GET /api/agents/:agentId/todos/agent-tasks
```

**过滤逻辑**:
```sql
-- Agent 任务: 非当前 agent 创建 OR 被指派给当前 agent
WHERE origin_agent_id != ? OR assigned_agent_id = ?

-- 人类任务: 当前 agent 创建 AND 未被指派
WHERE origin_agent_id = ? AND (assigned_agent_id IS NULL OR assigned_agent_id = ?)
```

### 3.2 任务列表标识

**文件**: `public/index.html`

- 任务列表增加 **🤖 Agent** 来源标签（紫色背景）
- 任务详情页显示 **"由 Agent 代理执行"** 或 **"👤 人工创建"**
- Blockers、progress、step 信息正常显示

### 3.3 Agent 任务保护

**文件**: `public/index.html`

- Agent 执行的任务**隐藏"强行驱动执行"按钮**
- 防止人类在 Web UI 干预 Agent 的自主执行流程

---

## 四、待实现功能

### P0 后端保护（高优先级）

**问题**: 前端隐藏按钮不够安全，API 直接调用仍可修改 Agent 任务状态

**方案**: 在 `PATCH /:id/status` 路由增加来源校验

```javascript
// src/routes/todos.js
router.patch('/:id/status', async (req, res) => {
  const todo = Todo.findById(agentId, id);
  const isAgentTask = todo.origin_agent_id !== agentId || todo.assigned_agent_id;

  if (isAgentTask) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Agent 执行的任务不能从 Web UI 修改状态'
    });
  }
  // ... 正常处理
});
```

**影响文件**: `src/routes/todos.js`

---

### P1 askForHelp 人类响应机制

**问题**: Agent 调用 `askForHelp` 后无人类介入通道

**方案**:

1. Web UI 增加"待响应"通知面板
2. 人类可以提供 input/approval/review
3. Agent 继续执行

```javascript
// StructuredDriveTools.js 中的 askForHelp
{
  tool: 'askForHelp',
  blocker: '需要人工审批 PR',
  neededResource: 'github token',
  alternativesTried: ['尝试跳过', '尝试用另一个 API']
}
```

**Web UI 响应界面**:
```
┌─────────────────────────────────────────────┐
│ 🚨 Agent 请求帮助                           │
│                                             │
│ 任务: 代码评审自动化                         │
│ Agent: Hermes (ops)                         │
│ 阻塞: 需要人工审批权限                       │
│                                             │
│ [提供审批链接]  [跳过此任务]  [联系 Agent]   │
└─────────────────────────────────────────────┘
```

**影响文件**:
- `src/routes/todos.js` (新增 `/ask-for-help` 响应端点)
- `src/models/Todo.js` (新增 `ask_for_help_responses` 表或字段)
- `public/index.html` (新增响应界面)

---

### P2 Agent 监控面板

**问题**: 无法一览所有 Agent 的活跃状态和任务执行情况

**方案**:

```
┌─────────────────────────────────────────────────────────────┐
│  Agent 活动监控                                              │
├─────────────────────────────────────────────────────────────┤
│  🤖 Hermes (ops)   🔄 执行中 (3任务)  ⚠️ 阻塞 (1)  🟢 健康 │
│  🤖 OpenClaw      💤 空闲                                  │
│  🤖 DevAgent      🔄 执行中 (1任务)  🟡 进展缓慢            │
└─────────────────────────────────────────────────────────────┘
```

**指标**:
- 活跃任务数 (in_progress)
- 阻塞任务数 (blocked)
- 健康度评分 (基于 heartbeat 频率)
- 最后活跃时间

**影响文件**:
- `src/routes/todos.js` (新增 `/agent-activity` 端点)
- `public/index.html` (新增 Agent 监控 Tab)

---

## 五、智能体功能概述

### 5.1 智能体工作进程

**文件**: `agent-worker.js`

独立的智能体执行进程，负责：
- 每 30 秒轮询 `focus_states`
- 调用 LLM 生成命令并执行
- 支持 bash 命令执行和进度报告

### 5.2 结构化工具调用系统

**文件**: `src/utils/StructuredDriveTools.js`

智能体工作时使用的工具集：

| 工具 | 功能 |
|------|------|
| `updateProgress` | 更新任务进度（progress/step/blockers） |
| `confirmCompletion` | 标记任务完成并提供验收证据 |
| `askForHelp` | 请求人工或外部支持 |

**工具定义示例**:
```javascript
{
  type: "function",
  function: {
    name: "askForHelp",
    description: "遇到无法自行解决的阻塞时调用，请求人工介入或外部支持。",
    parameters: {
      blocker: "阻塞的具体描述",
      neededResource: "需要什么资源或支持",
      alternativesTried: ["已经尝试过的替代方案"]
    }
  }
}
```

### 5.3 任务驱动引擎

**DriveOrchestrator**（在 `EXECUTION_GUARD.md` 中规划）：
- 服务器内置执行引擎
- 强制执行闭环验证
- 自动重试机制（最多 3 次）

### 5.4 多智能体支持

系统支持多个 Agent 协作：
- **Hermes**（ops）- 运维智能体
- **OpenClaw** - 数据采集智能体
- 可扩展其他智能体

### 5.5 Agent 相关数据模型

| 字段 | 说明 |
|------|------|
| `agent_id` | 任务所属智能体 |
| `origin_agent_id` | 任务创建者智能体 |
| `assigned_agent_id` | 被指派执行的智能体 |

### 5.6 askForHelp 当前实现

当智能体调用 `askForHelp` 时：
1. 更新任务状态为 `blocked`
2. 添加阻塞项到 `heartbeat_blockers`
3. 创建通知（`Notification.create`）

**缺少的功能**：当前无法向特定智能体发送询问请求，仅能创建通知等待人类响应。

---

## 六、优先级总结

| 优先级 | 功能 | 状态 | 影响文件 |
|--------|------|------|----------|
| P0 | 后端禁止修改 Agent 任务状态 | 🔴 待实现 | `src/routes/todos.js` |
| P1 | askForHelp 人类响应机制 | 🔴 待实现 | `src/routes/todos.js`, `public/index.html` |
| P2 | Agent 监控面板 | 🔴 待实现 | `src/routes/todos.js`, `public/index.html` |

---

## 七、相关文档

- [HERMES_INTEGRATION_DESIGN.md](../HERMES_INTEGRATION_DESIGN.md) - Hermes 统一调度集成
- [MULTI_AGENT_DESIGN.md](../MULTI_AGENT_DESIGN.md) - 多 Agent 协作设计
- [AGENT_INTEGRATION.md](../AGENT_INTEGRATION.md) - Agent 集成总览
- [EXECUTION_GUARD.md](./EXECUTION_GUARD.md) - 执行引擎与闭环验证

---

## 八、附录：每日调度重复任务问题

> 日期: 2026-05-02
> 状态: ✅ 已修复

### 问题描述

每日调度任务存在重复创建问题。原因：`spawnFromTemplate` 直接创建新实例，不检查同名进行中任务。

### 修复方案

**文件**: `src/models/Todo.js` - `Todo.spawnFromTemplate()`

```javascript
static spawnFromTemplate(agentId, templateId, options = {}) {
  const { replaceExisting = false } = options;

  if (replaceExisting) {
    // 查找同名进行中任务
    const activeDup = db.prepare(`
      SELECT id, title, status, priority, created_at FROM todos
      WHERE agent_id = ? AND title = ? AND archived = 0
        AND status NOT IN ('completed', 'cancelled')
        AND id != ?
      LIMIT 1
    `).get(agentId, template.title, templateId);

    if (activeDup) {
      // 旧任务标记为 cancelled + archived
      db.prepare(`
        UPDATE todos SET status = 'cancelled', archived = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND agent_id = ?
      `).run(activeDup.id, agentId);

      // 记录上下文
      Context.create(agentId, {
        sessionId: 'scheduler',
        role: 'system',
        content: `[DailyScheduler] 旧任务「${template.title}」(ID: ${activeDup.id}) 被新实例替换，已自动归档`,
        metadata: { type: 'task_replaced', old_task_id: activeDup.id, template_id: templateId }
      });
    }
  }

  // ... 正常创建新任务，transferred_from 记录替换关系
}
```

**文件**: `src/server.js` - DailyScheduler

```javascript
const spawned = Todo.spawnFromTemplate(agent.id, template.id, { replaceExisting: true });
```

### API 兼容性

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `skipDedupe` | `false` | 跳过重复检测 |
| `replaceExisting` | `false` | 是否替换同名任务 |
| `replacesId` | `null` | 手动指定被替换的任务 ID |
