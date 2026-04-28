# 多智能体任务协作设计方案

## 核心目标

让不同 Hermes Gateway（default / ops / coder）之间可以：
1. **创建任务并指派**给其他智能体执行
2. **查看自己被指派**的任务
3. **任务完成后通知**原创建者
4. **统一项目看板**（跨智能体视角）

---

## 一、数据库扩展

### 1. todos 表新增字段

```sql
ALTER TABLE todos ADD COLUMN origin_agent_id TEXT;        -- 任务创建者
ALTER TABLE todos ADD COLUMN assigned_agent_id TEXT;        -- 被指派的执行者
ALTER TABLE todos ADD COLUMN assignment_note TEXT DEFAULT ''; -- 指派说明
ALTER TABLE todos ADD COLUMN assigned_at DATETIME;          -- 指派时间
ALTER TABLE todos ADD COLUMN transferred_from TEXT;         -- 从哪个任务转移而来（可选）
```

### 2. 新增任务通知表

```sql
CREATE TABLE task_notifications (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,           -- 接收通知的 agent
  task_id TEXT NOT NULL,
  type TEXT CHECK(type IN ('assigned', 'completed', 'transferred', 'comment')),
  message TEXT NOT NULL,
  read BOOLEAN DEFAULT false,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES todos(id) ON DELETE CASCADE
);

CREATE INDEX idx_notifications_agent ON task_notifications(agent_id, read);
CREATE INDEX idx_notifications_task ON task_notifications(task_id);
```

---

## 二、权限模型

| 角色 | 权限 |
|------|------|
| **创建者**（origin_agent_id） | 查看、修改、取消、重新指派 |
| **执行者**（assigned_agent_id） | 更新进度、心跳、标记完成 |
| **其他 agent** | 完全不可见 |
| **系统管理员** | 全局查看（可选） |

---

## 三、API 扩展

### 3.1 任务指派

```http
POST /api/agents/:agentId/todos/:id/assign
Content-Type: application/json

{
  "assignedAgentId": "c24d64d7-5271-4860-a19f-f56b6d574ac5",  // coder
  "note": "需要你帮忙写 DuckDB 数据校验脚本部分"
}
```

**逻辑：**
1. 验证当前 agent 是任务创建者（origin_agent_id）
2. 验证目标 agent 存在
3. 更新 `assigned_agent_id`、`assignment_note`、`assigned_at`
4. 创建通知给执行者
5. 如果任务已有执行者，创建「任务被转移」通知给原执行者

**响应：**
```json
{
  "success": true,
  "data": {
    "task": { ... },
    "assigned_to": "hermes-coder",
    "notification_sent": true
  }
}
```

---

### 3.2 查询被指派给我的任务

```http
GET /api/agents/:agentId/todos/assigned-to-me
```

**逻辑：**
1. 查询 `assigned_agent_id = :agentId` 且 `status != 'completed'` 的任务
2. 按优先级排序

---

### 3.3 查询我创建的任务

```http
GET /api/agents/:agentId/todos/created-by-me
```

**逻辑：**
1. 查询 `origin_agent_id = :agentId` 的任务
2. 包含执行者信息、进度、状态

---

### 3.4 任务转交（执行者转给其他人）

```http
POST /api/agents/:agentId/todos/:id/transfer
Content-Type: application/json

{
  "newAssignedAgentId": "4b5ad916-435f-4292-be5c-8ec049e4faaa",  // ops
  "reason": "这个需要运维部署，我搞不定"
}
```

**逻辑：**
1. 验证当前 agent 是执行者
2. 更新 `assigned_agent_id`
3. 记录 `transferred_from`（上一个执行者）
4. 通知原创建者 + 新执行者

---

### 3.5 通知查询

```http
GET /api/agents/:agentId/notifications
GET /api/agents/:agentId/notifications?unread=true
```

```http
POST /api/agents/:agentId/notifications/:id/read  // 标记已读
```

---

### 3.6 跨智能体项目看板

```http
GET /api/projects/:id/board
```

**逻辑：**
1. 查询项目下的所有任务（不限制 agent_id）
2. 按执行者分组展示
3. 返回全局进度统计

**响应：**
```json
{
  "success": true,
  "data": {
    "project": { "id": "...", "name": "股票数据系统" },
    "tasks_by_agent": {
      "hermes-default": [{ "id": "...", "title": "需求分析", "status": "completed" }],
      "hermes-coder": [{ "id": "...", "title": "编写校验脚本", "status": "in_progress" }],
      "hermes-ops": [{ "id": "...", "title": "部署定时任务", "status": "pending" }]
    },
    "overall_progress": 0.35,
    "blocked_tasks": []
  }
}
```

---

## 四、SDK 扩展

```javascript
// 指派任务
sdk.assignTask(todoId, { assignedAgentId, note })

// 查询被指派给我的任务
sdk.getAssignedTasks()

// 查询我创建的任务
sdk.getCreatedTasks()

// 转交任务
sdk.transferTask(todoId, { newAssignedAgentId, reason })

// 获取通知
sdk.getNotifications({ unreadOnly: true })
sdk.markNotificationRead(notificationId)

// 跨智能体项目看板
sdk.getProjectBoard(projectId)
```

---

## 五、交互流程示例

### 场景：default 创建任务 → 指派给 coder → coder 完成 → 通知 default

**Step 1: default 创建并指派**
```
用户: "帮我做一个股票数据系统"

default 智能体:
  1. 拆解子任务
  2. 生成验收标准
  3. 创建任务（origin_agent_id = default）
  4. 调用 sdk.assignTask(taskId, { assignedAgentId: coder, note: "写校验脚本" })
  5. TODO Server 创建通知给 coder

回复用户: "已创建任务并指派给 coder 执行"
```

**Step 2: coder 收到任务**
```
coder 智能体启动 / 定期轮询:
  GET /api/agents/coder/todos/assigned-to-me
  → 发现新任务「编写 DuckDB 校验脚本」
  
coder:
  1. Focus Engine 自动聚焦该任务
  2. 开始执行
  3. 每 5 分钟心跳上报进度
```

**Step 3: coder 完成，通知 default**
```
coder 智能体:
  1. 判断任务完成
  2. 展示验收清单给用户确认
  3. 用户确认后调用 completeTodo()
  4. TODO Server 自动创建通知给 default
  
通知内容: "任务「编写 DuckDB 校验脚本」已完成，请验收"
```

**Step 4: default 验收**
```
default 智能体轮询通知:
  GET /api/agents/default/notifications
  → 发现 coder 完成任务的通知
  
default:
  1. 查看任务详情和验收报告
  2. 通知用户: "coder 已完成校验脚本，是否验收？"
  3. 用户确认后，检查父任务是否全部完成
  4. 父任务全部完成 → 自动完成父任务
```

---

## 六、需要修改的文件清单

| 文件 | 修改内容 |
|------|---------|
| `src/db.js` | 新增字段 + `task_notifications` 表 |
| `src/models/Todo.js` | `assign()`、`getAssignedToMe()`、`getCreatedByMe()`、`transfer()` |
| `src/models/Notification.js` | 新增 Model |
| `src/routes/todos.js` | `/assign`、`/transfer` 路由 |
| `src/routes/notifications.js` | 新增路由文件 |
| `src/routes/projects.js` | `/board` 全局看板 |
| `src/server.js` | 挂载 notifications 路由 |
| `sdk/agent-todo-sdk.js` | 新增指派/通知相关方法 |
| `framework/modules/TaskManager.js` | 集成指派方法 |

---

## 七、与 Skill 接入的关系

多智能体协作是**独立能力**，不阻塞 Skill 接入。可以：

**方案 A：先接入 Skill（单智能体），再扩展协作**
- 先让 default / ops / coder 各自独立使用 TODO Skill
- 稳定后再增加跨智能体指派

**方案 B：一次性实现（推荐如果协作是核心需求）**
- 同时做 Skill 接入 + 多智能体协作
- 但开发量更大

---

你倾向哪种方案？
- **A**: 先做单智能体 Skill 接入，后续扩展协作
- **B**: 一次性做完，包括多智能体指派和通知