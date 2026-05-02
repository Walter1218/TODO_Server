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

## 五、优先级总结

| 优先级 | 功能 | 状态 | 影响文件 |
|--------|------|------|----------|
| P0 | 后端禁止修改 Agent 任务状态 | 🔴 待实现 | `src/routes/todos.js` |
| P1 | askForHelp 人类响应机制 | 🔴 待实现 | `src/routes/todos.js`, `public/index.html` |
| P2 | Agent 监控面板 | 🔴 待实现 | `src/routes/todos.js`, `public/index.html` |

---

## 六、相关文档

- [HERMES_INTEGRATION_DESIGN.md](../HERMES_INTEGRATION_DESIGN.md) - Hermes 统一调度集成
- [MULTI_AGENT_DESIGN.md](../MULTI_AGENT_DESIGN.md) - 多 Agent 协作设计
- [AGENT_INTEGRATION.md](../AGENT_INTEGRATION.md) - Agent 集成总览
