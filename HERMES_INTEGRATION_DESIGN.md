# Hermes 智能体 × TODO Server 集成设计方案

> 目标：让 TODO Server 成为 Hermes 智能体的「外置任务大脑」，实现任务自动管理 + 上下文聚焦。

## 📋 实现状态

| 模块 | 设计 | 实现 | 验证 |
|------|:----:|:----:|:----:|
| TODO Server API（任务/项目/Agent） | ✅ | ✅ | ✅ |
| 聚焦引擎（Focus Engine） | ✅ | ✅ | ✅ |
| 心跳追踪 + 卡住检测 | ✅ | ✅ | ✅ |
| 重试管理 + 熔断降级 | ✅ | ✅ | ✅ |
| 验收标准 + 显式确认 | ✅ | ✅ | ✅ |
| 漂移检测 | ✅ | ✅ | ✅ |
| 任务自动发现 + 确认创建 | ✅ | ✅ | ✅ |
| 多智能体协作（指派/转交/通知） | ✅ | ✅ | ✅ |
| 项目全局看板 | ✅ | ✅ | ✅ |
| 对话上下文存储 | ✅ | ✅ | ✅ |
| Hermes Skill（Python CLI） | ✅ | ✅ | ✅ |
| Profile 感知 + 凭证映射 | ✅ | ✅ | ✅ |
| WebSocket 实时推送 | ✅ | ❌ | ❌ |
| 可视化管理界面 | ✅ | ❌ | ❌ |

---

## 一、整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                      Hermes Gateway                              │
│           (ai.hermes.gateway / ops / coder)                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌──────────────┐    ┌──────────────────┐    ┌───────────┐    │
│   │   Core Bot   │◄──►│   Skill Manager  │◄──►│  LLM API  │    │
│   │  (现有逻辑)   │    │  (技能注册中心)   │    │ (kimi等)  │    │
│   └──────┬───────┘    └────────┬─────────┘    └───────────┘    │
│          │                     │                                 │
│          │        ┌────────────┼────────────┐                  │
│          │        ▼            ▼            ▼                  │
│          │   ┌────────┐  ┌──────────┐  ┌────────────┐         │
│          │   │Memory  │  │  TODO    │  │  Context   │         │
│          │   │ Skill  │  │  Skill   │  │  Skill     │         │
│          │   └────────┘  └────┬─────┘  └────────────┘         │
│          │                    │                                 │
│          └────────────────────┘                                 │
│                               (通过事件总线通信)                 │
└─────────────────────────────────────────────────────────────────┘
                                │
                                │ HTTP / WebSocket
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                     TODO Server (port 3000)                      │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌──────────────────┐  │
│  │  Tasks  │  │ Context │  │ Memory  │  │   Focus Engine   │  │
│  │ (tasks) │  │(context)│  │(memory) │  │  (上下文聚焦器)   │  │
│  └─────────┘  └─────────┘  └─────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**核心原则**：
1. **Skill = 可插拔能力包** — Hermes 加载 TODO Skill 后，自动获得任务管理能力
2. **TODO Server = 外置大脑** — 任务、上下文、记忆全部外置，agent 重启不丢失
3. **自动交互 = 零感知** — 用户和 agent 对话时，skill 在后台自动与 TODO Server 交互

---

## 二、TODO Skill 设计（Hermes 侧）

### 2.1 Skill 生命周期

```javascript
// hermes-todo-skill/index.js
class HermesTODOSkill {
  constructor(options) {
    this.agentId = options.agentId;        // "hermes-default"
    this.secretKey = options.secretKey;    // 从 TODO Server 注册获取
    this.baseUrl = options.todoServerUrl;  // "http://localhost:3000"
    this.sdk = new AgentTODOSDK(this.baseUrl, this.agentId, this.secretKey);
    
    // 配置开关
    this.autoCreateTasks = true;    // 自动从对话中发现任务
    this.autoUpdateStatus = true;   // 自动更新任务状态
    this.injectContext = true;      // 每次对话前注入任务上下文
    this.memoryEnabled = true;      // 自动提取记忆
  }

  // Skill 被 Hermes 加载时调用
  async onMount(hermesGateway) {
    this.gateway = hermesGateway;
    
    // 注册事件监听器
    hermesGateway.on('message:receive', this.onUserMessage.bind(this));
    hermesGateway.on('message:send', this.onBotReply.bind(this));
    hermesGateway.on('session:start', this.onSessionStart.bind(this));
    hermesGateway.on('session:end', this.onSessionEnd.bind(this));
    
    console.log(`[TODO Skill] 已挂载到 ${this.agentId}`);
  }

  // Skill 被卸载时调用
  async onUnmount() {
    this.gateway.off('message:receive', this.onUserMessage);
    this.gateway.off('message:send', this.onBotReply);
    console.log(`[TODO Skill] 已从 ${this.agentId} 卸载`);
  }
}
```

### 2.2 核心事件处理

#### A. 会话开始时注入上下文（Focus）

```javascript
async onSessionStart(session) {
  if (!this.injectContext) return;
  
  // 从 TODO Server 获取当前聚焦摘要
  const { message } = await this.sdk.focus();
  
  // 注入到 Hermes 的系统 prompt
  session.systemPrompt += `\n\n=== 当前任务聚焦 ===\n${message}\n`;
  
  // 如果有被阻塞的高优先级任务，特别标注
  const summary = await this.sdk.getContextSummary();
  const blocked = summary.data.blocked || [];
  if (blocked.length > 0) {
    session.systemPrompt += `\n⚠️ 注意：你有 ${blocked.length} 个被阻塞的任务需要处理。\n`;
  }
}
```

#### B. 收到用户消息时 → 查询相关任务

```javascript
async onUserMessage(message, session) {
  if (!this.injectContext) return;
  
  // 搜索与当前话题相关的任务
  const related = await this.sdk.searchTodos(message.text);
  
  // 如果有高度相关的进行中的任务，注入到上下文
  const relevant = related.data?.filter(t => 
    t.status === 'in_progress' || t.status === 'pending'
  ).slice(0, 3);
  
  if (relevant.length > 0) {
    session.context.tasks = relevant.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      context: t.context
    }));
  }
}
```

#### C. 发送 Bot 回复后 → 自动分析并更新 TODO

```javascript
async onBotReply(reply, session) {
  const fullConversation = session.getRecentMessages(5);
  
  // 1. 自动更新任务状态（调用 LLM 分析）
  if (this.autoUpdateStatus) {
    const actions = await this.analyzeConversation(fullConversation);
    for (const action of actions) {
      if (action.type === 'complete') {
        await this.sdk.completeTodo(action.taskId);
        console.log(`[TODO] 自动完成任务: ${action.title}`);
      } else if (action.type === 'start') {
        await this.sdk.startTask(action.taskId);
        console.log(`[TODO] 自动开始任务: ${action.title}`);
      }
    }
  }
  
  // 2. 自动发现新任务（调用 LLM 分析）
  if (this.autoCreateTasks) {
    const newTasks = await this.discoverNewTasks(fullConversation);
    for (const task of newTasks) {
      await this.sdk.quickAdd(task.title, {
        priority: task.priority,
        context: task.context,
        tags: task.tags
      });
      console.log(`[TODO] 自动创建任务: ${task.title}`);
    }
  }
  
  // 3. 提取记忆
  if (this.memoryEnabled) {
    await this.memorySkill.extractAndStore(reply, session.lastUserMessage);
  }
}
```

### 2.3 LLM 分析 Prompt（自动发现任务）

```javascript
async discoverNewTasks(conversation) {
  const prompt = `分析以下对话，判断用户或AI是否提出了新的待办任务。

对话：
${conversation.map(m => `${m.role}: ${m.content}`).join('\n')}

如果对话中明确出现了"需要做"、"待办"、"计划做"、"回头弄"等含义，提取为任务。
忽略闲聊和已经明确的任务更新。

返回纯JSON数组：
[
  {"title": "任务标题", "priority": "high/medium/low", "context": "补充说明", "tags": ["标签"]}
]
没有新任务则返回 []`;

  const result = await this.llm.chat({ messages: [{ role: 'user', content: prompt }] });
  return JSON.parse(result.content.match(/\[[\s\S]*\]/)[0]);
}
```

---

## 三、TODO Server 扩展设计

### 3.1 新增数据表

```sql
-- 对话上下文表（按 session 存储）
CREATE TABLE contexts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- 聚焦状态表（每个 agent 当前聚焦的任务）
CREATE TABLE focus_states (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE,
  current_task_id TEXT,
  focus_mode TEXT DEFAULT 'auto',  -- auto / manual / pinned
  context_window_size INTEGER DEFAULT 10,
  last_focused_at DATETIME,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (current_task_id) REFERENCES todos(id) ON DELETE SET NULL
);
```

### 3.2 新增 API 路由

```javascript
// contexts.js
router.post('/:agentId/contexts', requireAgentAuth, (req, res) => {
  // 保存对话上下文
});

router.get('/:agentId/contexts', requireAgentAuth, (req, res) => {
  // 获取最近 N 轮对话
});

router.get('/:agentId/contexts/summary', requireAgentAuth, (req, res) => {
  // 获取上下文摘要（用于注入 prompt）
});

// focus.js
router.get('/:agentId/focus', requireAgentAuth, (req, res) => {
  // 获取当前聚焦状态 + 任务详情 + 上下文提示
});

router.put('/:agentId/focus', requireAgentAuth, (req, res) => {
  // 手动切换聚焦任务
});

router.post('/:agentId/focus/auto', requireAgentAuth, (req, res) => {
  // 让 Focus Engine 自动选择下一个应该聚焦的任务
});
```

### 3.3 Focus Engine（上下文聚焦器）

```javascript
class FocusEngine {
  // 自动选择当前应该聚焦的任务
  async autoFocus(agentId) {
    const todos = await Todo.findAllByAgent(agentId);
    
    // 优先级排序算法
    const candidates = todos
      .filter(t => t.status === 'pending' || t.status === 'in_progress')
      .map(t => ({
        ...t,
        score: this.calculateFocusScore(t)
      }))
      .sort((a, b) => b.score - a.score);
    
    return candidates[0] || null;
  }
  
  calculateFocusScore(todo) {
    let score = 0;
    
    // 优先级权重
    const priorityWeight = { critical: 100, high: 50, medium: 20, low: 5 };
    score += priorityWeight[todo.priority] || 0;
    
    // 依赖就绪度（所有依赖都完成 → 加分）
    if (todo.dependencies.length === 0) score += 30;
    else if (this.allDependenciesResolved(todo)) score += 25;
    
    // 时效性（越老的 pending 任务分数越高）
    const age = Date.now() - new Date(todo.created_at).getTime();
    score += Math.min(age / (24 * 3600 * 1000), 20); // 每天 +1 分，最多 +20
    
    // 上下文匹配度（如果最近对话提到了这个任务 → 大幅加分）
    if (this.recentlyMentioned(todo)) score += 40;
    
    return score;
  }
}
```

---

## 四、MVP 实现步骤（以 hermes-default 为范例）

### 阶段 1：TODO Server 核心开发 ✅

1. **数据库层**
   - ✅ `agents`, `projects`, `todos` 基础表
   - ✅ `focus_states`, `contexts` 上下文表
   - ✅ `task_notifications` 通知表
   - ✅ 安全迁移（ALTER TABLE ADD COLUMN）
   - ✅ WAL 模式

2. **API 层**
   - ✅ 完整 REST API（CRUD + 依赖 + 状态）
   - ✅ Agent 认证（secret_key）+ 跨 agent 操作
   - ✅ Focus Engine 路由（`/focus/auto`）
   - ✅ Heartbeat 路由（`/:id/heartbeat`）
   - ✅ 多智能体协作路由（assign / transfer / notifications）
   - ✅ 项目看板路由（`/projects/:id/board`）

3. **SDK 层**
   - ✅ JavaScript SDK（完整 CRUD + 协作）
   - ✅ Python CLI Skill（`todo_skill.py`）

### 阶段 2：框架智能化 ✅

1. **聚焦引擎**
   - ✅ 自动评分：priority + age + ready - retry penalty
   - ✅ `focus_states` 表记录当前/上次聚焦

2. **心跳与重试**
   - ✅ 5 分钟心跳间隔
   - ✅ 30 分钟无心跳 → stuck
   - ✅ 3 次重试 → blocked

3. **验收标准**
   - ✅ LLM 生成 checklist
   - ✅ 用户确认前不可执行
   - ✅ 完成时二次确认

4. **漂移检测**
   - ✅ LLM 语义分析偏离度
   - ✅ drift_score >= 0.6 主动提醒
   - ✅ 提供 [A]回任务 [B]新任务 [C]暂停

5. **熔断 + 本地缓存**
   - ✅ 3 次失败进入 degraded 模式
   - ✅ 本地缓存路径：`~/.hermes/skills/todo/cache/`
   - ✅ 30 秒恢复探测

### 阶段 3：多智能体协作 ✅

1. **任务指派/转交**
   - ✅ `POST /:id/assign` + `POST /:id/transfer`
   - ✅ `origin_agent_id` 记录创建者
   - ✅ `assigned_agent_id` 记录执行者
   - ✅ 自动创建目标 agent（如果不存在）

2. **跨 agent 通知**
   - ✅ `task_notifications` 表
   - ✅ assigned / transferred / completed / comment 类型
   - ✅ 未读计数 + 标记已读

3. **项目看板**
   - ✅ `GET /projects/:id/board`
   - ✅ 按 agent 分组统计

### 阶段 4：Skill 接入 ✅

1. **Python CLI**
   - ✅ `~/.hermes/skills/hermes-todo-skill/todo_skill.py`
   - ✅ stats / focus / auto-focus / list / create / assign / transfer / notifications

2. **凭证映射**
   - ✅ `agents.yaml` 映射 profile → agent_id + secret_key
   - ✅ Profile 感知（根据 `HERMES_HOME` 自动匹配）

3. **同步到所有 profile**
   - ✅ default / ops / coder 都已挂载

### 阶段 5：剩余工作（可选增强）

1. ❌ WebSocket 实时推送
2. ❌ 可视化管理界面
3. ❌ Docker Compose 部署

---

## 五、配置示例

```yaml
# ~/.hermes/config.yaml
platforms:
  feishu:
    enabled: true
    # ...

skills:
  - name: todo
    enabled: true
    config:
      todo_server_url: "http://localhost:3000"
      auto_create_tasks: true
      auto_update_status: true
      inject_context: true
      memory_enabled: true
      # 可选：自定义聚焦策略
      focus_mode: "auto"  # auto / manual / pinned
      context_window_size: 10
```

---

## 六、关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| Skill 挂载方式 | Hermes Gateway 启动时加载 | 与现有插件体系一致 |
| 与 TODO Server 通信 | HTTP REST API | 简单、可靠、易调试 |
| 上下文存储位置 | TODO Server (SQLite) | 统一持久化、agent 重启不丢失 |
| 自动任务发现 | LLM 分析对话 | 比关键词更准确 |
| 聚焦策略 | 自动评分 + 可手动覆盖 | 智能但可控 |
| 多 agent 隔离 | 每个 agent 独立 agent_id | default/ops/coder 互不干扰 |

---

这个方案的核心是：**TODO Server 成为 Hermes 智能体的「外置状态机」** — 任务、上下文、记忆全部外置，智能体本身保持无状态，随时可以重启、切换、扩展。
