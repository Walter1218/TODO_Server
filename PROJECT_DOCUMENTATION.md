# Agent TODO Server 项目文档

> 最后更新：2026-05-04
> 本文档为项目唯一主文档，其他独立文档已废弃，内容已合并至此。

---

## 一、项目概述

### 1.1 核心问题

- 智能体在长对话中上下文窗口膨胀
- 多次复杂任务后出现任务发散
- 历史信息淹没关键任务
- 多智能体之间任务不透明、无法协作

### 1.2 解决方案

- **外部化任务记忆**：任务状态持久化到 SQLite，agent 重启不丢失
- **聚焦引擎**：自动选择最优任务，注入上下文
- **心跳追踪**：实时监控任务执行进度和阻塞
- **多智能体协作**：任务指派、转交、跨 agent 通知
- **验收标准**：LLM 生成检查清单，用户确认后执行
- **自动运维监控**：`StuckMonitor`、`DriveOrchestrator` 与 `ValidatorService` 协同工作，实现无人值守的任务修复与验收
- **Agent-to-Agent 自驱校验**：Worker 执行，Validator 验收，Orchestrator 编排，彻底跳出 Human-in-the-loop（支持第三方 Agent 独立验证）
- **LLM Agent Loop**：`ValidationAgent` 采用多轮工具调用（ReAct 模式）独立验证任务，最多 10 轮迭代，支持 RESULT-FIRST 验证策略、事实快速路径、系统日志过滤、收敛规则和强制判定兜底
- **结构化驱动工具**：`StructuredDriveTools` 提供 `updateProgress`、`proposeCompletion`、`confirmCompletion`、`askForHelp` 等结构化工具，替代脆弱的文本解析
- **LLM Provider 热插拔**：运行时通过 API 切换 LLM Provider（OpenAI / Anthropic / MiniMax / Ollama），无需重启服务，支持主备自动切换

### 1.3 技术栈

- **运行时**：Node.js (>= 18)
- **框架**：Express
- **数据库**：SQLite (WAL 模式)
- **进程管理**：PM2
- **LLM 支持**：MiniMax / OpenAI / Anthropic / Ollama

---

## 二、项目结构

```
TODO_Server/
├── src/                          # TODO Server API
│   ├── server.js                 # Express 服务器入口 + 认证中间件 + 自动运维监控
│   ├── db.js                     # SQLite 数据库（WAL 模式 + 自动迁移）
│   ├── models/                   # 数据模型
│   │   ├── Agent.js              # 智能体 CRUD + secret_key
│   │   ├── Todo.js               # 任务 CRUD + 协作 + 调度 + 归档 + 校验状态
│   │   ├── Project.js            # 项目 CRUD
│   │   ├── FocusState.js         # 聚焦状态管理
│   │   ├── Context.js            # 对话上下文存储
│   │   └── Notification.js       # 跨 agent 通知
│   ├── routes/                   # API 路由
│   │   ├── agents.js             # 智能体注册
│   │   ├── todos.js              # 任务 CRUD + 指派/转交/心跳/驱动/验收
│   │   ├── projects.js           # 项目 + 全局看板
│   │   ├── focus.js              # 聚焦引擎
│   │   ├── contexts.js           # 上下文存储
│   │   ├── notifications.js      # 通知管理
│   │   └── llm.js                # LLM Provider 状态查询 + 热插拔切换
│   └── services/
│       ├── CommandExecutor.js    # 命令提取与执行
│       ├── DriveOrchestrator.js  # 自动化任务驱动器
│       ├── ProgressValidator.js  # 任务进展验证器
│       ├── ValidatorService.js   # Agent-to-Agent 自动化校验服务
│       ├── ValidationAgent.js    # 内嵌验证智能体（LLM + 工具调用）
│       ├── ValidationDispatchService.js # 第三方验证任务派发服务
│       └── TaskReportService.js  # 任务流程报告生成服务
├── sdk/
│   └── agent-todo-sdk.js         # JavaScript SDK（完整 CRUD + 协作 + 调度）
├── framework/                    # 可选：内置框架客户端（LLM 驱动）
│   ├── core/Framework.js         # 主框架（熔断 + 本地缓存 + 状态机）
│   ├── modules/
│   │   ├── TaskManager.js        # 任务管理
│   │   ├── ContextManager.js     # 上下文管理
│   │   ├── MemoryManager.js      # 记忆管理（内存 + 文件持久化）
│   │   ├── PromptManager.js      # Prompt 增强 + 角色模板
│   │   └── ProactiveManager.js   # 主动交互 + 漂移检测
│   ├── llm/                      # LLM Provider 抽象层
│   │   ├── LLMProvider.js        # 基类
│   │   ├── MiniMaxProvider.js    # MiniMax 适配
│   │   ├── OpenAIProvider.js     # OpenAI 适配
│   │   ├── AnthropicProvider.js  # Anthropic 适配
│   │   ├── OllamaProvider.js     # Ollama 本地模型适配
│   │   ├── LLMFactory.js         # Provider 工厂
│   │   └── LLMManager.js         # 管理器（主备切换）
│   └── utils/ConfigLoader.js     # 配置加载器
├── skills/
│   └── hermes-todo-skill/         # Hermes Skill 接入层
│       ├── SKILL.md              # Skill 定义
│       ├── todo_skill.py          # Python CLI
│       ├── todo_skill_config.yaml
│       └── agents.yaml            # Profile → Agent 凭证映射
├── scripts/                      # 工具脚本
├── public/                       # Web 管理界面（基础版）
├── data/                         # SQLite 数据库（自动创建，已 gitignore）
├── logs/                         # 日志目录（自动创建，已 gitignore）
├── config.json                   # 框架配置（setup 生成，已 gitignore）
├── ecosystem.config.js           # PM2 集群配置
└── package.json
```

---

## 三、快速开始

### 3.1 安装

```bash
# 克隆项目
git clone <repo-url>
cd TODO_Server

# 安装依赖并初始化环境
npm install
npm run setup
```

`npm run setup` 会自动完成：
- ✅ 检查 Node.js 版本（>= 18）
- ✅ 创建 `data/`、`logs/` 目录
- ✅ 生成 `.env` 环境变量文件
- ✅ 生成 `config.json` 框架客户端配置（含随机 agent ID）

### 3.2 配置

#### 服务器环境变量（`.env`）

```bash
PORT=3000              # 服务端口
DB_PATH=./data/todo.db # 数据库路径
LOG_LEVEL=info         # 日志级别
NODE_ENV=development   # 运行环境
```

#### 框架客户端配置（`config.json`）

如需使用内置框架客户端（`npm run agent`），编辑 `config.json`：

```json
{
  "server": { "url": "http://localhost:3000" },
  "llm": {
    "provider": "minimax",
    "minimax": {
      "apiKey": "your-api-key",
      "model": "MiniMax-Text-01"
    }
  },
  "agent": {
    "id": "your-agent-id",
    "name": "我的智能体"
  }
}
```

### 3.3 启动与管理

```bash
# 一键启动所有服务 (Server + 3 Hermes Agents)
npm run pm2:start

# 查看集群状态
npm run pm2:status

# 查看实时日志
npm run pm2:logs

# 停止 / 重启集群
npm run pm2:stop
npm run pm2:restart
```

**传统启动方式（仅用于调试）：**
```bash
# 启动 TODO Server API
npm start

# 启动框架客户端
node start.js --config config.hermes-coder.json
```

### 3.4 部署 Hermes Skill

```bash
npm run setup:hermes
```

---

## 四、核心功能

### 4.1 任务管理

- 创建 / 更新 / 删除 / 查询
- 4 级优先级：`critical` / `high` / `medium` / `low`
- 标签系统、上下文字段、位置排序
- 子任务（`parent_id`）+ 自动完成父任务检测
- 任务搜索（标题/描述/上下文模糊匹配）

### 4.2 依赖管理

- 任务间依赖关系
- 循环依赖检测（DFS 算法）
- 可执行任务筛选（依赖已满足）
- 依赖树查询

### 4.3 聚焦引擎（Focus Engine）

```http
POST /api/agents/:id/focus/auto
```

**LLM 增强自动选优**：
- 多个候选任务时，LLM 综合紧急程度、完成难度、依赖关系、风险评估选择最优任务
- 单候选或无 LLM 时，回退到评分算法：`score = priority_weight(critical=100) + age_bonus(max 20) + ready_bonus(max 30) - retry_penalty`
- 每次任务创建/完成/状态变更后自动重新评估聚焦

**LLM 任务状态推断**：
- 优先复用 `LLMInferencer` 后台推断结果（5 分钟缓存）
- 无缓存时实时发起 LLM 分析：判断智能体是否在工作、当前动作、建议状态
- LLM 不可用时自动回退到阈值规则引擎
- `LLMInferencer` 后台每 5 分钟扫描 idle 5-15 分钟的任务，高置信度（≥0.75）时自动标记 completed/blocked

### 4.4 心跳与重试追踪

- 每 5 分钟上报进度、当前步骤、阻塞项
- 超过 30 分钟无心跳 → 自动标记为 stuck
- 超过最大重试次数（默认 3）→ 自动标记为 `blocked`

### 4.5 验收标准与自驱校验

- **验收清单**：LLM 自动生成结构化验收清单，用户确认后开始执行
- **自驱验收**：Worker 完成任务后调用 `proposeCompletion()`，状态转为 `pending_validation`
- **自动质检**：`ValidatorService` 自动读取执行上下文并进行 LLM 审计，通过则标记 `completed`，失败则打回并附带改进建议
- **ValidationAgent（内置 LLM Agent Loop）**：
  - **RESULT-FIRST 验证策略**：以任务实际产出（数据文件、数据库记录）为判定依据，禁止基于 Agent 运行状态（focus_task、idle）做判定
  - LLM + 工具调用的 ReAct 模式，最多 10 轮迭代
  - 5 个工具：`exec_shell`、`read_duckdb`、`check_file`、`get_execution_logs`、`get_task_info`
  - **事实快速路径**：attempt_count=0 时先用工具检查 DuckDB 数据库、数据目录等实际产出物，有事实证据即通过，无证据才拒绝
  - **系统日志过滤**：`_getExecutionLogs` 过滤 14 种系统前缀（DriveOrchestrator、StuckTaskMonitor 等）和 14 种系统 metadata 类型，只返回 Agent 真正的执行日志
  - **强制判定兜底**：LLM 达到迭代上限未给出结论时，基于已有证据正/负面比例自动生成判定，避免迭代耗尽直接失败
  - **收敛规则**：第 4 轮提醒产出结论，第 7 轮警告为最后一轮工具调用，第 9 轮强制输出 JSON 判定
  - 工具安全约束：只读权限、危险命令过滤、沙箱路径限制、30s 超时、1000 字符截断
  - 显式传递 maxTokens: 100000 确保完整输出
- **第三方验证（可选，默认关闭）**：通过 `ValidationDispatchService` 派发独立验证任务给另一个 Agent（如 hermes-ops），由第三方 Agent 独立调查并通过 `/validation-report` API 提交验证报告
- **任务流程报告**：验证完成后自动生成任务报告，包含基本信息、执行记录、验证记录和时间线，支持 JSON 和 Markdown 格式

### 4.6 多智能体协作

| 能力 | API |
|------|-----|
| 指派任务 | `POST /todos/:id/assign` |
| 转交任务 | `POST /todos/:id/transfer` |
| 我创建的任务 | `GET /todos/created` |
| 指派给我的 | `GET /todos/assigned` |
| 跨 agent 通知 | `GET /notifications` |
| 项目全局看板 | `GET /projects/:id/board` |
| 自动创建被指派 agent | 指派时自动注册不存在的 agent |

### 4.7 定时调度任务

- 任务模板（`is_template=true`）+ 调度规则（`schedule`）
- 支持格式：`daily`、`weekly:mon,fri`、`cron:0 9 * * *`
- **模板 → 实例**：DailyScheduler 每分钟检查到期模板，自动 spawn 实例
- **实例 → 报告**：Hermes cron job 通过 `GET /todos/scheduled/pending` 查询待执行实例
- spawn 时自动创建 `task_notification`（assigned 类型），通知 agent 有新实例待执行
- 手动触发模板实例化：`POST /todos/:id/spawn`

### 4.8 自动运维监控

| 监控模块 | 间隔 | 功能 |
|---------|------|------|
| StuckTaskMonitor | 3min | 基于动态阈值检测无心跳任务，自动恢复/标记 blocked |
| DriveOrchestrator | 60s | 扫描所有有 focus 的任务，自动 drive + 验证，maxConcurrent=5 |
| ValidatorService | 随 Drive | 检测到 `pending_validation` 任务时自动调用 ValidationAgent 执行异步校验 |
| LLMInferencer | 5min | LLM 推断 idle 5-15 分钟的任务真实状态，高置信度自动标记 |
| WorkSnapshotMonitor | 30s | 采集所有 Agent 工作快照到 contexts |
| DailyScheduler | 60s | 检查到期的模板任务并生成实例 |
| CronExecutionMonitor | 60s | 检测未按时启动的定时实例 |
| AssignmentDriver | 60s | 自动聚焦已指派但未执行的任务 |
| CleanupMonitor | 24h | 归档超过 30 天的 completed/cancelled 任务 |

---

## 五、API 速查

### 5.1 智能体

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agents` | 注册智能体 |
| GET | `/api/agents/:id` | 查询智能体 |
| DELETE | `/api/agents/:id` | 删除智能体 |

### 5.2 任务

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agents/:id/todos` | 创建任务 |
| GET | `/api/agents/:id/todos` | 列出任务 |
| GET | `/api/agents/:id/todos/:id` | 获取任务 |
| PUT | `/api/agents/:id/todos/:id` | 更新任务 |
| DELETE | `/api/agents/:id/todos/:id` | 删除任务 |
| PATCH | `/api/agents/:id/todos/:id/status` | 更新状态 |
| POST | `/api/agents/:id/todos/:id/assign` | 指派任务 |
| POST | `/api/agents/:id/todos/:id/transfer` | 转交任务 |
| POST | `/api/agents/:id/todos/:id/heartbeat` | 更新心跳 |
| POST | `/api/agents/:id/todos/:id/attempt` | 记录重试 |
| POST | `/api/agents/:id/todos/:id/drive` | 手动驱动执行 |
| POST | `/api/agents/:id/todos/:id/spawn` | 模板实例化 |
| POST | `/api/agents/:id/todos/:id/report` | cron job 写入执行报告 |
| POST | `/api/agents/:id/todos/:id/propose-completion` | 申请验收 |
| GET | `/api/agents/:id/todos/:id/report` | 获取任务流程报告 |
| GET | `/api/agents/:id/todos/assigned` | 指派给我的 |
| GET | `/api/agents/:id/todos/created` | 我创建的 |
| GET | `/api/agents/:id/todos/stuck/list` | 卡住的任务 |
| GET | `/api/agents/:id/todos/stats` | 任务统计 |
| GET | `/api/agents/:id/todos/search?q=xxx` | 搜索任务 |
| GET | `/api/agents/:id/todos/ready` | 可执行任务 |
| GET | `/api/agents/:id/todos/templates` | 模板任务列表 |
| GET | `/api/agents/:id/todos/scheduled/pending` | 待执行模板实例 |
| POST | `/api/agents/:id/todos/archive-old` | 归档旧任务 |
| DELETE | `/api/agents/:id/todos/archived` | 删除已归档任务 |

### 5.3 聚焦

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/agents/:id/focus` | 当前聚焦 |
| PUT | `/api/agents/:id/focus` | 手动设置聚焦 |
| POST | `/api/agents/:id/focus/auto` | 自动聚焦 |

### 5.4 项目

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agents/:id/projects` | 创建项目 |
| GET | `/api/agents/:id/projects` | 列出项目 |
| GET | `/api/agents/:id/projects/:id` | 获取项目 |
| GET | `/api/agents/:id/projects/:id/board` | 项目看板 |

### 5.5 通知

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/agents/:id/notifications` | 获取通知 |
| POST | `/api/agents/:id/notifications/:id/read` | 标记已读 |
| POST | `/api/agents/:id/notifications/read-all` | 全部已读 |

### 5.6 上下文

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agents/:id/contexts` | 存储消息 |
| GET | `/api/agents/:id/contexts` | 查询消息 |
| GET | `/api/agents/:id/contexts/summary` | 会话摘要 |

### 5.7 LLM 管理（热插拔）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/llm/status` | 查询当前 LLM Provider 状态 |
| POST | `/api/llm/swap` | 运行时切换 LLM Provider |

**切换 LLM Provider**：

```http
POST /api/llm/swap
Content-Type: application/json

{
  "provider": "openai",
  "apiKey": "sk-xxx",
  "model": "gpt-4o",
  "testTimeoutMs": 10000
}
```

**支持的 provider**：`openai`、`anthropic`、`minimax`、`ollama`

**切换流程**：创建新 Provider → 测试连接 → 原子切换 → 释放旧 Provider

**编程方式切换**（Framework 侧）：

```javascript
await framework.swapLLMProvider({
  provider: 'anthropic',
  apiKey: 'sk-ant-xxx',
  model: 'claude-3-5-haiku-20241022'
});
```

---

## 六、SDK 使用

### 6.1 JavaScript SDK

```javascript
const AgentTODOSDK = require('./sdk/agent-todo-sdk');

const sdk = new AgentTODOSDK(
  'http://localhost:3000',
  'agent-id',
  'secret-key'
);

// 快速创建任务
await sdk.createTodo({ title: '完成报告', priority: 'high' });

// 自动聚焦
const { data } = await sdk.autoFocus();

// 更新心跳
await sdk.updateHeartbeat(taskId, {
  progress: 50,
  step: '编写数据层',
  blockers: ['等待API文档']
});

// 多智能体协作
await sdk.assignTask(taskId, 'hermes-ops', { note: '请部署到生产环境' });
await sdk.transferTask(taskId, 'hermes-coder', { note: '需要代码审查' });

// 申请验收（推荐完成方式）
await sdk.proposeCompletion(taskId);
```

### 6.2 Python CLI（Hermes Skill）

```bash
# 查看统计
python3 ~/.hermes/skills/hermes-todo-skill/todo_skill.py stats

# 自动聚焦
python3 ~/.hermes/skills/hermes-todo-skill/todo_skill.py auto-focus

# 创建任务
python3 ~/.hermes/skills/hermes-todo-skill/todo_skill.py create --title "新任务"

# 指派任务
python3 ~/.hermes/skills/hermes-todo-skill/todo_skill.py assign \
  --task-id <id> --target-agent hermes-ops

# 申请验收
python3 ~/.hermes/skills/hermes-todo-skill/todo_skill.py propose-completion --task-id <UUID>

# 查看通知
python3 ~/.hermes/skills/hermes-todo-skill/todo_skill.py notifications
```

---

## 七、配置体系

### 7.1 三层配置

1. **`.env`** — 服务器运行时环境变量
2. **`config.json`** — 框架客户端配置（LLM、功能开关）
3. **`agents.yaml`** — Hermes Skill 凭证映射（多智能体协作）

### 7.2 环境变量

```bash
PORT=3000              # 服务端口
DB_PATH=./data/todo.db # SQLite 数据库路径
LOG_LEVEL=info         # 日志级别
NODE_ENV=development   # 运行环境
```

### 7.3 框架配置（config.json）

```json
{
  "server": { "url": "http://localhost:3000" },
  "llm": {
    "provider": "minimax",
    "minimax": {
      "apiKey": "local",
      "groupId": "local",
      "baseUrl": "http://localhost:3456",
      "model": "MiniMax-M2.7",
      "temperature": 0.7,
      "maxTokens": 100000
    },
    "openai": { "apiKey": "", "model": "gpt-3.5-turbo", "temperature": 0.7, "maxTokens": 100000 },
    "anthropic": { "apiKey": "", "model": "claude-3-5-haiku-20241022", "temperature": 0.7, "maxTokens": 100000 },
    "fallback": {
      "provider": "ollama",
      "baseUrl": "http://localhost:11434/v1",
      "model": "Qwen3.5_9b_f16:latest",
      "temperature": 0.7,
      "maxTokens": 100000
    }
  },
  "agent": { "id": "", "name": "" },
  "features": {
    "taskManagement": { "enabled": true, "autoCreateTasks": false, "autoUpdateStatus": false, "priority": "medium" },
    "contextManagement": { "enabled": true, "injectInterval": "every_turn", "maxContextLength": 2000, "prioritizeBy": "priority" },
    "memoryManagement": { "enabled": false, "memoryRetention": 7 },
    "promptManagement": { "enabled": true, "autoEnhance": true, "addChecklist": true, "addProgress": true },
    "proactiveInteraction": { "enabled": true, "remindInterval": 5, "suggestOnIdle": true },
    "dependencyManagement": { "enabled": true, "showBlockers": true }
  }
}
```

**LLM 配置说明**：
- `provider`：默认使用哪个 Provider（`minimax` / `openai` / `anthropic`）
- `fallback`：主 Provider 不可用时的备用 Provider（默认 Ollama 本地模型）
- `maxTokens`：统一设置为 100000，确保 ValidationAgent 多轮工具调用和长文本输出不被截断
- `temperature`：所有 Provider 统一 0.7
- `LLMManager` 在调用 Provider 时正确透传 `maxTokens` 和 `temperature` 参数（支持 per-call 覆盖）
- **热插拔**：运行时可通过 `POST /api/llm/swap` 或 `framework.swapLLMProvider()` 切换 Provider，无需重启。切换流程：创建新实例 → 连接测试 → 原子替换 → 释放旧实例

### 7.4 Skill 凭证映射（agents.yaml）

```yaml
agents:
  default:
    agent_id: <uuid>
    secret_key: <key>
    name: hermes-default
  ops:
    agent_id: <uuid>
    secret_key: <key>
    name: hermes-ops
  coder:
    agent_id: <uuid>
    secret_key: <key>
    name: hermes-coder
```

---

## 八、Agent-to-Agent 自驱校验架构

### 8.1 核心角色

| 角色 | 职责 |
|------|------|
| **Manager Agent** | 负责全局目标拆解，生成验收标准，指派任务 |
| **Worker Agent** | 通过 SDK 接收任务，自驱执行并上报心跳，完成后申请验收 |
| **Validator Agent** | 独立审核 Worker 的执行过程与产出，判定是否符合验收标准 |

### 8.2 自动化工作流

```
1. 指派 (Assign): Manager 创建任务并设置 acceptance_criteria，状态设为 pending
2. 执行 (Execute): Worker 执行任务，通过 updateHeartbeat 上报进度
3. 申请验收 (Propose): Worker 调用 proposeCompletion()，状态转为 pending_validation
4. 自动审计 (Validate): 
   - 模式A（内置）: ValidatorService 检测到待校验任务，读取 contexts 进行 LLM 评审
   - 模式B（第三方）: ValidationDispatchService 派发独立验证任务给另一个 Agent（如 hermes-ops）
5. 闭环 (Close):
   - PASS → 状态更新为 completed
   - FAIL → 状态变更为 validation_failed，记录反馈，通知 Worker 修正
```

### 8.3 关键组件

| 组件 | 文件 | 职责 |
|------|------|------|
| DriveOrchestrator | `src/services/DriveOrchestrator.js` | 流程编排器，驱动任务执行 |
| ValidatorService | `src/services/ValidatorService.js` | 自动化校验服务（内置 LLM 评审）|
| ValidationDispatchService | `src/services/ValidationDispatchService.js` | 第三方验证任务派发服务 |
| CommandExecutor | `src/services/CommandExecutor.js` | bash 命令提取与安全执行 |
| ProgressValidator | `src/services/ProgressValidator.js` | 执行前后进度对比验证 |
| StuckTaskMonitor | `src/server.js` | 动态阈值卡住检测与恢复 |
| TaskType | `src/utils/TaskType.js` | 任务类型系统（类型识别、行为配置） |
| ValidationAgent | `src/services/ValidationAgent.js` | 内嵌验证智能体（LLM + 工具调用） |

### 8.4 内嵌验证智能体（ValidationAgent）

#### 8.4.1 设计背景

现有的 `ValidatorService` 依赖 LLM "读日志写评语"，本质上是一个**被动阅读器**——它只能阅读 Agent 提交的日志，无法独立验证事实。同时，第三方验证（ValidationDispatchService 派发给 hermes-tester）存在派发无闭环的问题。

核心问题：
- 验证器无法独立验证任务是否真的完成（数据是否写入、文件是否存在、脚本是否可执行）
- LLM 只能"相信"日志里写的，无法形成独立的证据链
- 每种新任务类型需要手写验证规则模板，维护成本高

#### 8.4.2 设计目标

将验证器从"被动读日志的评审员"升级为**"有工具能力的验证智能体"**：
- LLM 验证器能自主决定验证策略（无需预设规则模板）
- 通过工具调用主动验证事实（查数据库、跑脚本、检查文件）
- 自适应任意新任务类型，无需维护验证规则模板

#### 8.4.3 架构概览

```
┌──────────────────────────────────────────────┐
│            ValidationAgent (新)               │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │  System Prompt（验证器角色定义）      │    │
│  └──────────────────────────────────────┘    │
│                    │                         │
│                    ▼                         │
│  ┌──────────────────────────────────────┐    │
│  │        Agent Loop（最多 10 轮）       │    │
│  │                                      │    │
│  │   ┌──────────────┐                   │    │
│  │   │ LLM + Tools  │◄── messages       │    │
│  │   └──────┬───────┘                   │    │
│  │          │                           │    │
│  │     tool_calls? ──yes──► 执行工具    │    │
│  │          │                   │       │    │
│  │          │            工具结果反馈    │    │
│  │          │                   │       │    │
│  │     final_answer? ──yes──► 返回结论  │    │
│  │                                      │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  工具集：                                     │
│  ┌──────────────────────────────────────┐    │
│  │ 1. exec_shell      执行 shell 命令   │    │
│  │ 2. read_duckdb     查询 DuckDB       │    │
│  │ 3. check_file      检查文件/目录      │    │
│  │ 4. get_execution_logs 读取执行日志    │    │
│  │ 5. get_task_info   获取任务元信息     │    │
│  └──────────────────────────────────────┘    │
└──────────────────────────────────────────────┘
```

#### 8.4.4 基础设施就绪状态

| 组件 | 现状 | 改动需求 |
|------|------|---------|
| `LLMManager.chat()` | ✅ 已支持 `tools` 参数和 `toolCalls` 返回，正确透传 `maxTokens`/`temperature` | 无 |
| `Framework.generateResponseRaw()` | ✅ 已支持 tools 透传 | 无 |
| `MiniMaxProvider.chat()` | ✅ 已支持 tools 参数传递和 tool_calls 响应解析 | 无 |
| `OpenAIProvider.chat()` | ✅ 已支持 tools 参数传递和 tool_calls 响应解析 | 无 |
| `OllamaProvider.chat()` | ✅ 已支持 tools 参数传递和 tool_calls 响应解析 | 无 |
| `ValidatorService` | ✅ 已重构为调用 ValidationAgent，保持外部接口不变 | 无 |
| `CommandExecutor` | ✅ 支持命令执行、超时控制、结果摘要 | 无 |

#### 8.4.5 工具集定义

##### 工具 1：exec_shell

执行 shell 命令并返回输出。用于运行脚本、检查进程、验证数据等。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| command | string | 是 | 要执行的 shell 命令 |
| cwd | string | 否 | 工作目录 |
| timeout_ms | number | 否 | 超时毫秒数（默认 30000） |

##### 工具 2：read_duckdb

查询 DuckDB 数据库，返回 SQL 查询结果。用于验证数据完整性和新鲜度。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| db_path | string | 是 | DuckDB 文件路径 |
| sql | string | 是 | SQL 查询语句 |

##### 工具 3：check_file

检查文件或目录是否存在，获取大小和修改时间。用于验证备份文件、数据文件状态。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| path | string | 是 | 文件或目录路径 |

##### 工具 4：get_execution_logs

获取被验证任务的执行日志（上下文记录）。用于了解 Agent 实际做了什么。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| task_id | string | 是 | 被验证的任务 ID |
| limit | number | 否 | 获取的日志条数（默认 50） |

##### 工具 5：get_task_info

获取任务的元信息（标题、描述、验收标准、尝试次数、状态等）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| task_id | string | 是 | 任务 ID |

#### 8.4.6 Agent Loop 核心逻辑

```javascript
async validate(agentId, task) {
  const systemPrompt = this.buildSystemPrompt(task);
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `请验证任务「${task.title}」是否已完成。` }
  ];

  for (let i = 0; i < this.maxIterations; i++) {
    const response = await this.llmManager.chat({ messages: [...messages], tools: VALIDATOR_TOOLS });

    if (response.toolCalls?.length > 0) {
      messages.push({ role: 'assistant', content: response.content || '', tool_calls: response.toolCalls });
      for (const toolCall of response.toolCalls) {
        const result = await this.executeTool(toolCall, agentId, task);
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) });
      }
      continue;
    }

    if (response.content) {
      return this.parseJudgment(response.content);
    }
  }

  return { pass: false, reason: '验证器达到最大迭代次数未给出结论', score: 0, evidence, forcedJudgment: true };
}
```

#### 8.4.7 验证结果格式

```javascript
{
  "pass": true | false,       // 是否通过
  "reason": "简要原因",        // 判断依据
  "score": 0-100,             // 质量评分
  "evidence": [               // 证据链（工具调用记录）
    { "tool": "read_duckdb", "args": {...}, "result": "..." },
    { "tool": "check_file", "args": {...}, "result": "..." }
  ],
  "feedback": "如不通过，给出修正建议"
}
```

#### 8.4.8 安全约束

| 约束 | 实现方式 |
|------|---------|
| **只读权限** | 工具白名单，不提供写入/删除类工具 |
| **命令过滤** | 复用 `DANGEROUS_PATTERNS` 黑名单，禁止 `rm -rf`、`DROP`、`DELETE`、`TRUNCATE` 等危险命令 |
| **沙箱路径限制** | `exec_shell` 仅允许在项目目录和 `/tmp` 下执行 |
| **超时保护** | 每个工具调用最多 30 秒 |
| **循环次数上限** | Agent Loop 最多 10 轮（`MAX_ITERATIONS=10`） |
| **响应截断** | 工具返回结果超过 1000 字符时自动截断（`MAX_OUTPUT_LENGTH=1000`） |
| **收敛强制** | 第 4 轮提醒产出结论，第 7 轮警告为最后一轮工具调用，第 9 轮强制输出 JSON 判定 |
| **事实快速路径** | attempt_count=0 时先用工具检查 DuckDB 数据库、数据目录等实际产出物，有证据即通过，无证据才拒绝 |
| **强制判定兜底** | LLM 达到迭代上限未给出结论时，基于已有证据正/负面比例自动生成判定，避免迭代耗尽直接失败 |
| **系统日志过滤** | `_getExecutionLogs` 过滤 14 种系统前缀和 14 种系统 metadata 类型，只返回 Agent 真正的执行日志 |

#### 8.4.9 集成到现有流程

```
当前流程：
  task 完成 → pending_validation → ValidatorService(LLM 读日志) → pass/fail

改后流程：
  task 完成 → pending_validation → ValidationAgent(LLM + 工具调用) → pass/fail
                                       │
                                       ├─ 事实快速路径: attempt_count=0 → 检查 DuckDB/数据目录
                                       ├─ LLM 读取任务信息和验收标准
                                       ├─ LLM 读取执行日志（已过滤系统日志），形成初步假设
                                       ├─ LLM 通过工具主动验证事实
                                       │   ├─ 查 DuckDB 验证数据写入
                                       │   ├─ 检查文件/目录状态
                                       │   ├─ 跑脚本验证可执行性
                                       │   └─ 回查日志验证一致性
                                       ├─ 第 4 轮提醒收敛，第 7 轮警告，第 9 轮强制输出
                                       └─ LLM 综合证据给出最终判断（或 _forceJudgment 兜底）
```

`ValidatorService.validateTask()` 外部接口保持不变，内部切换为调用 `ValidationAgent`。

#### 8.4.10 与第三方验证的关系

| 场景 | 处理方式 |
|------|---------|
| 有明确验收标准的任务 | ValidationAgent 自主验证，不派发第三方 |
| 需要领域专家判断的任务 | ValidationAgent 完成技术验证后，仍可派发第三方做业务判断 |
| 验证失败需要修正的任务 | ValidationAgent 的 feedback 直接写入 context，供 Worker 读取修正 |

#### 8.4.11 实施状态

| 步骤 | 改动文件 | 说明 | 状态 |
|------|---------|------|------|
| 1 | `framework/llm/MiniMaxProvider.js`、`OpenAIProvider.js`、`OllamaProvider.js` | 传递 tools 参数、解析 tool_calls 响应 | ✅ 已完成 |
| 2 | `src/services/ValidationAgent.js` | 实现 Agent Loop + 5 个验证工具 + RESULT-FIRST 验证策略 + 事实快速路径 + 系统日志过滤 + 强制判定兜底 | ✅ 已完成 |
| 3 | `src/services/ValidatorService.js` | 内部切换到 ValidationAgent，保持外部接口不变 | ✅ 已完成 |
| 4 | `src/services/DriveOrchestrator.js` | 优化 validation_failed 处理逻辑 + maxConcurrentDrives=5 + shouldDrive parent_id 守卫 | ✅ 已完成 |
| 5 | `framework/llm/LLMManager.js` | 修复 maxTokens/temperature 透传 bug | ✅ 已完成 |
| 6 | 所有 config 文件 | maxTokens 统一升级到 100000 | ✅ 已完成 |
| 7 | `src/models/FocusState.js` | createOrUpdate 非法 focusMode 值自动修正守卫 | ✅ 已完成 |

---

## 九、任务类型系统

### 9.1 概述

任务类型系统提供统一的任务类型识别和行为配置，确保不同类型任务获得正确的处理逻辑。

### 9.2 任务类型定义

| 类型 | 标识 | 说明 |
|------|------|------|
| 普通任务 | `normal` | 默认类型，完成后触发验证流程 |
| 验证任务 | `validation` | 第三方验证任务，完成后直接结束 |
| 模板任务 | `template` | 用于创建新任务的蓝图 |
| 定时任务 | `scheduled` | 按计划自动执行的任务 |

### 9.3 任务行为配置

| 行为属性 | 普通任务 | 验证任务 | 模板任务 | 定时任务 |
|---------|---------|---------|---------|---------|
| 完成后触发验证 | ✅ | ❌ | ❌ | ✅ |
| 允许重新验证 | ✅ | ❌ | ❌ | ✅ |
| 优先级提升 | 0 | +10 | 0 | +5 |
| 超时时间(分钟) | 60 | 30 | 60 | 120 |
| Focus 保护 | ❌ | ✅ | ❌ | ❌ |

### 9.4 类型识别规则

```javascript
// 识别优先级
1. is_template = true → 模板任务
2. title 以 "[验证]" 开头 → 验证任务
3. context.type = "third_party_validation" → 验证任务
4. context.type = "scheduled" → 定时任务
5. 默认 → 普通任务
```

### 9.5 API

```javascript
const { 
  getTaskType,        // 获取任务类型
  getTaskBehavior,    // 获取行为配置
  isValidationTask,   // 是否验证任务
  shouldTriggerValidation,  // 是否触发验证
  getTaskTypeLabel,   // 获取类型标签（中文）
  getTaskTimeout,     // 获取超时时间(ms)
  getTaskPriority     // 获取优先级（含提升）
} = require('./utils/TaskType');
```

### 9.6 使用示例

```javascript
const task = { title: '[验证] 数据同步检查', context: '{"type":"third_party_validation"}' };

if (isValidationTask(task)) {
  // 验证任务特殊处理
  console.log(`任务类型: ${getTaskTypeLabel(task)}`);  // 输出: 验证任务
  console.log(`超时时间: ${getTaskTimeout(task) / 60000} 分钟`);  // 输出: 30 分钟
}
```

---

## 十、典型案例分析：stk_limit 补采任务

### 10.1 案例背景

任务「**A股 stk_limit 补采到 2026-04-30**」是一个典型的数据补采任务，用于同步涨跌停限制数据。该任务在执行过程中经历了完整的自驱校验流程，并最终失败，为我们提供了宝贵的改进机会。

### 10.2 任务详情

| 属性 | 内容 |
|------|------|
| 标题 | A股 stk_limit 补采到 2026-04-30 |
| 状态 | `validation_failed` |
| 优先级 | medium |
| 尝试次数 | 3/3 |
| 创建时间 | 2026-05-02 10:53:39 |
| 任务 ID | `99907e7e-2792-465e-ac62-2947b4c59abe` |

### 10.3 任务描述

```
当前 DuckDB fact_stk_limit 只到 2026-03-20（735,327行），需要补采到 2026-04-30。

步骤：
1. kill $(lsof -ti /Users/onetwo/.openclaw/workspace/tushare_warehouse/data/tushare_stklimit.duckdb) 2>/dev/null
2. cd /Users/onetwo/.openclaw/workspace/tushare_warehouse && TUSHARE_API_TOKEN="xxx" /opt/homebrew/bin/python3 -u scripts/fetch_stk_limit.py
3. 验证：duckdb /Users/onetwo/.openclaw/workspace/tushare_warehouse/data/tushare_stklimit.duckdb -c "SELECT MIN(trade_date), MAX(trade_date), COUNT(*) FROM fact_stk_limit"
预期结果：MAX(trade_date) = 2026-04-30
```

### 10.4 执行过程

1. **第一次执行**：Agent 收到任务，但未执行任何命令
2. **第二次执行**：Agent 尝试执行命令但失败，duckdb 命令不可用
3. **第三次执行**：脚本执行后无验证，progress 达到 100% 但未通过验收

### 10.5 失败原因分析

**核心问题**：Agent 未完成验证步骤。

验证报告显示（score 40%）：
```json
{
  "pass": false,
  "reason": "任务执行存在重大缺陷：1) fetch_stk_limit.py 脚本执行后（耗时338秒，采集了77天中的部分数据），但没有完成验证步骤来确认 MAX(trade_date) 是否达到 2026-04-30；2) duckdb 验证命令在整个日志中始终失败（command not found），从未成功执行过；3) 由于缺少最终验证结果，无法确认数据是否真正补采到目标日期 2026-04-30",
  "feedback": "虽然脚本启动了且有数据采集迹象（显示'[1/77] 20260430'），但验收标准明确要求验证 MAX(trade_date) = 2026-04-30，这一关键步骤未完成。建议：1) 确认 duckdb 客户端是否可用，或使用其他方式（如 Python + duckdb 库）验证；2) 检查 fetch_stk_limit.py 是否正常结束（可能只采集了部分日期）；3) 如果脚本中断，需重新执行并确保完整采集到 2026-04-30；4) 必须执行验证查询并确认结果后才能通过验收",
  "score": 40
}
```

### 10.6 问题根因

1. **环境问题**：duckdb 命令在当前环境不可用，应使用 Python + duckdb 库替代
2. **命令提取机制单一**：仅支持代码块格式，无法从任务描述中提取命令
3. **缺乏自动重试机制**：校验失败后任务停留在 `validation_failed` 状态，已达到最大尝试次数

### 10.7 改进措施（已实施）

| 改进项 | 文件 | 说明 |
|--------|------|------|
| 增强驱动 Prompt | `src/utils/driveHelper.js` | 添加明确的命令输出格式要求 |
| 扩展命令提取 | `src/services/CommandExecutor.js` | 支持从任务描述中提取步骤命令 |
| 支持 validation_failed 重试 | `src/services/DriveOrchestrator.js` | 自动重试并携带校验反馈给 LLM |
| 100%进度自动触发验证 | `src/services/DriveOrchestrator.js` | 进度达到100%时自动转为 pending_validation |
| 验证反馈传递给重试 | `src/services/DriveOrchestrator.js` | buildRetryContext 包含验证失败反馈 |
| 第三方验证机制 | `src/services/ValidationDispatchService.js` | 派发独立验证任务给第三方 Agent |

### 10.8 改进后的执行流程

```
1. 任务创建 → pending
2. DriveOrchestrator 检测 → in_progress
3. 驱动执行（新Prompt）→ 输出命令
4. CommandExecutor 提取命令（从描述）→ 执行
5. 进度 100% → 自动触发验证
6. 验证流程（可配置）:
   - 模式A: ValidatorService 内置校验 → completed / validation_failed
   - 模式B: 派发第三方验证任务 → hermes-ops 独立调查 → 提交验证报告 → completed / validation_failed
7. 如失败 → 自动重试（携带反馈）→ 最多3次
```

### 10.9 经验教训

- 命令执行任务应优先使用 Python 库而非 shell 命令（如 duckdb 而非 duckdb CLI）
- 验证步骤必须作为命令的一部分执行，而不仅仅是在描述中说明
- 自动重试机制需要正确传递验证反馈给 LLM，避免重复相同错误

---

## 十一、Web UI 与 Agent 任务融合

### 11.1 来源过滤

系统通过 `source` 字段区分任务来源（agent/human）：
- **Agent 任务**：非当前 agent 创建 OR 被指派给当前 agent
- **人类任务**：当前 agent 创建且未被指派

### 11.2 Web UI 保护措施

- 任务列表增加 🤖 Agent 标识（紫色背景）
- Agent 执行的任务**隐藏"强行驱动执行"按钮**
- 任务详情页区分来源

### 11.3 待实现功能

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P0 | 后端禁止修改 Agent 任务状态 | API 层校验来源，禁止人类修改 Agent 任务 |
| P1 | askForHelp 人类响应机制 | Web UI 增加"待响应"通知面板 |
| P2 | Agent 监控面板 | 一览所有 Agent 的活跃状态和任务执行情况 |

---

## 十二、功能矩阵

| 功能 | Server | SDK | Framework | Skill | 说明 |
|------|:------:|:---:|:---------:|:-----:|------|
| 任务 CRUD | ✅ | ✅ | ✅ | ✅ | 基础管理 |
| 优先级 | ✅ | ✅ | ✅ | ✅ | 4 级 |
| 标签 | ✅ | ✅ | ✅ | ✅ | 多标签 |
| 依赖关系 | ✅ | ✅ | ✅ | ✅ | + 循环检测（DFS） |
| 项目分组 | ✅ | ✅ | ✅ | ✅ | + 看板 |
| 聚焦引擎 | ✅ | ✅ | ✅ | ✅ | LLM 增强选优 + 自动重评估 |
| 工作状态推断 | ✅ | - | - | - | LLM 推断 + 规则兜底 + 缓存复用 |
| 心跳追踪 | ✅ | ✅ | - | ✅ | 5min 间隔 |
| 重试管理 | ✅ | ✅ | - | ✅ | 3 次上限 |
| 验收标准 | ✅ | ✅ | ✅ | ✅ | LLM 生成 + 确认 |
| 自驱校验 | ✅ | ✅ | - | ✅ | ValidationAgent(LLM+Tools) + ValidationDispatchService 第三方 |
| 多智能体指派 | ✅ | ✅ | - | ✅ | 跨 agent + 自动创建 |
| 跨 agent 通知 | ✅ | ✅ | - | ✅ | assigned/transferred |
| 上下文存储 | ✅ | ✅ | ✅ | ✅ | 按 session |
| 定时调度 | ✅ | ✅ | - | - | 模板 spawn → cron report |
| 手动驱动 | ✅ | - | ✅ | - | LLM 执行 + 恢复 |
| 自动运维监控 | ✅ | - | - | - | 9 个监控模块（DriveOrchestrator + StuckMonitor + LLMInferencer 等） |
| 任务归档清理 | ✅ | - | - | - | 软删除 + 自动归档 |
| 熔断 + 本地缓存 | - | - | ✅ | - | 3 次失败降级 |
| LLM 集成 | ✅ | - | ✅ | - | Server 聚焦/推断 + Framework 全模块 |
| LLM Provider tools | ✅ | - | ✅ | - | MiniMax/OpenAI/Ollama/Anthropic 全部支持 |
| LLM Provider 热插拔 | ✅ | - | - | - | 运行时切换 Provider，无需重启 |
| Agent Loop（验证） | ✅ | - | - | - | ValidationAgent 10 轮工具调用 + RESULT-FIRST + 系统日志过滤 + 强制判定兜底 |
| StructuredDriveTools | ✅ | - | - | - | updateProgress/proposeCompletion/confirmCompletion/askForHelp |
| 角色模板系统 | - | - | ✅ | - | 通用/编码/分析/DevOps |
| 记忆管理 | - | - | ✅ | - | 提取 + 自动摘要 |
| WebSocket 实时推送 | - | - | - | - | ❌ 待实现 |
| 可视化管理界面 | 部分 | - | - | - | 🔴 待完善 |
| Docker 部署 | - | - | - | - | ❌ 待实现 |
| 代码执行 Hook 心跳 | - | - | - | - | ❌ 待实现 |

---

## 十三、版本进度

### 13.1 已完成

- [x] TODO Server 完整 REST API（30+ 路由）
- [x] SQLite 数据库 + WAL 模式 + 自动迁移
- [x] Agent 认证（secret_key）+ 跨 agent 操作
- [x] JavaScript SDK（完整 CRUD + 协作 + 调度）
- [x] 聚焦引擎（Focus Engine）自动选优 + 状态变更自动重评估
- [x] 心跳追踪（Heartbeat）+ 动态阈值卡住检测
- [x] 重试管理（attempt_count / max_attempts）
- [x] 验收标准生成 + 显式确认
- [x] 多智能体协作（指派 / 转交 / 通知 + 自动创建被指派 agent）
- [x] 项目全局看板（跨 agent 统计）
- [x] 对话上下文存储 + 会话摘要
- [x] 定时调度统一架构（模板 spawn → parent_id 链接 → cron report）
- [x] 手动驱动执行（LLM 执行 + 恢复 blocked 任务）
- [x] 循环依赖检测（DFS 算法）
- [x] 熔断 + 本地缓存降级
- [x] LLM Provider 抽象层（MiniMax / OpenAI / Anthropic / Ollama）
- [x] 主备 LLM 自动切换（含 maxTokens/temperature 透传）
- [x] 角色模板系统（通用/编码/分析/DevOps）
- [x] 记忆管理（提取 + 自动摘要 + 过期清理）
- [x] LLM 全模块集成（聚焦选优 / 工作状态推断 / 上下文排序）
- [x] AssignmentDriver 指派任务自动驱动
- [x] DriveOrchestrator 全自动任务驱动引擎（maxConcurrent=5）
- [x] ValidatorService Agent-to-Agent 自动化质检（内置 ValidationAgent）
- [x] StuckTaskMonitor 动态阈值卡住检测
- [x] LLMInferencer 后台智能状态推断
- [x] CleanupMonitor 自动归档超过 30 天的任务
- [x] Python CLI Skill（`propose-completion`）
- [x] Profile 感知自动匹配凭证
- [x] Skill 同步到所有 Hermes profile
- [x] **ValidationAgent（LLM Agent Loop + 5 个工具）** — 多轮工具调用独立验证
- [x] **所有 Provider tools 支持** — MiniMax/OpenAI/Ollama/Anthropic 全部支持 tools
- [x] **LLMManager 参数透传修复** — maxTokens/temperature 正确传递到 Provider
- [x] **maxTokens 统一升级 100000** — 所有 Provider 和 ValidationAgent 统一
- [x] **收敛规则 + 快速路径 + 系统提醒** — 防止 ValidationAgent 无限循环
- [x] **StructuredDriveTools** — updateProgress/proposeCompletion/confirmCompletion/askForHelp
- [x] **DriveOrchestrator 优化** — validation_count < 3 规则、validation_failed 自动重试
- [x] **LLM Provider 热插拔** — 运行时切换 Provider（API + Framework），无需重启

### 11.2 待实现

| 优先级 | 功能 | 预估工作量 | 收益 |
|--------|------|-----------|------|
| ~~P0~~ | ~~**内嵌验证智能体（ValidationAgent）**~~ | ~~2-3 天~~ | ~~高~~ |
| ~~P0~~ | ~~LLM Provider tools 支持（MiniMax/OpenAI）~~ | ~~0.5 天~~ | ~~高~~ |
| P0 | 后端禁止修改 Agent 任务状态 | 0.5 天 | 高（安全性） |
| P0 | Agent Loop Agent Loop ReAct 升级（DriveOrchestrator 多步推理） | 2-3 天 | 高（任务完成率） |
| P1 | WebSocket 实时推送 | 1-2 天 | 中（体验提升） |
| P1 | 可视化管理界面完善 | 2-3 天 | 高（运维友好） |
| P1 | 任务优先级管理机制 | 1-2 天 | 高（防止验证任务被抢占） |
| P1 | Token 预算控制与用量追踪 | 1-2 天 | 中（成本控制+防无限循环） |
| P1 | 统一调度器（替代 server.js 9 个 setInterval） | 1-2 天 | 中（可维护性） |
| P2 | askForHelp 人类响应机制 | 1 天 | 中（协作增强） |
| P2 | Agent 监控面板 | 1-2 天 | 中（可观测性） |
| P2 | Agent 间消息总线（双向对话能力） | 1-2 天 | 中（协作增强） |
| P2 | Agent LLM 配置隔离（per-agent 模型/参数配置） | 0.5 天 | 中（灵活性） |
| P2 | 单元测试 + 集成测试 | 1-2 天 | 中（质量保障） |
| P2 | Docker Compose 部署 | 0.5 天 | 中（部署便利） |
| P3 | Streaming 响应支持（SSE + Agent 边生成边执行） | 2-3 天 | 低（体验提升） |
| P3 | OpenTelemetry 可观测性增强 | 2-3 天 | 低（调试便利） |
| P3 | 插件化工具系统（动态工具加载） | 2-3 天 | 低（扩展性） |
| P3 | 代码执行 Hook 心跳 | 1 天 | 低（进度准确性） |

> 注：标记 ~~删除线~~ 的项目已在最新版本中完成。

### 11.3 任务优先级管理机制设计（待实现）

#### 11.3.1 问题背景

当前系统存在以下问题：
1. **验证任务被抢占**：hermes-tester 在处理多个验证任务时，可能因为某个任务触发 LLM 响应而导致 focus 被切换到其他任务
2. **任务执行不连贯**：长时间运行的任务可能被短时间任务抢占 focus
3. **缺乏优先级感知**：DriveOrchestrator 的任务选择不区分任务类型

#### 11.3.2 设计目标

1. **验证任务优先**：确保验证任务（hermes-tester 负责的任务）有更高的优先级
2. **抢占机制**：高优先级任务可以抢占低优先级任务的 focus
3. **公平调度**：同优先级任务按时间顺序执行

#### 11.3.3 优先级分类

| 优先级 | 任务类型 | 说明 |
|--------|---------|------|
| CRITICAL | 验证任务 | hermes-tester 的第三方验证任务 |
| HIGH | 关键业务任务 | 带有 `critical` 或 `high` 标签的任务 |
| MEDIUM | 普通任务 | 默认优先级 |
| LOW | 后台任务 | 可以被抢占的任务 |

#### 11.3.4 实现要点

1. **DriveOrchestrator 优先级选择**
   - 按优先级排序：CRITICAL > HIGH > MEDIUM > LOW
   - 同优先级按 `updated_at` 升序（先来先服务）

2. **Focus 抢占机制**
   - 当高优先级任务出现时，自动切换 focus
   - 被抢占的任务状态保持不变，只是暂时让出 focus

3. **验证任务特殊处理**
   - 验证任务的 context 中包含 `type: "third_party_validation"`
   - DriveOrchestrator 扫描时应优先派发验证任务

4. **智能体专注模式**
   - hermes-tester 切换到验证任务后，自动进入"专注模式"
   - 专注模式下不响应其他非验证任务的 focus 切换

#### 11.3.5 相关代码位置

- `src/services/DriveOrchestrator.js` - 任务派发逻辑
- `src/routes/focus.js` - Focus 切换逻辑
- `agent-worker.js` - 智能体任务执行

### 11.4 里程碑

| 里程碑 | 状态 | 说明 |
|--------|------|------|
| **MVP** | ✅ 完成 | Server API + SDK + 聚焦引擎 + 心跳 |
| **V1.0** | ✅ 完成 | + 验收标准 + 多智能体协作 + Skill 接入 + 自驱校验 |
| **V1.1** | ✅ 完成 | + ValidationAgent Agent Loop + Provider tools + 结构化驱动工具 |
| **V1.2** | 🔄 计划 | + ReAct Agent Loop 升级 + WebSocket + 可视化管理界面完善 |
| **V1.3** | 📋 计划中 | + Docker + 单元测试 + Python SDK + 可观测性 |

---

## 十四、已废弃文档

以下文档内容已合并到本文档并已清理：

| 废弃文档 | 合并内容 | 状态 |
|---------|---------|------|
| `TODO_ROADMAP.md` | 版本进度、功能矩阵 → 第十二章 | ✅ 已清理 |
| `AGENT_INTEGRATION.md` | SDK 使用、CLI 命令 → 第六章 | ✅ 已清理 |
| `HERMES_INTEGRATION_DESIGN.md` | 架构设计 → 第八章 | ✅ 已清理 |
| `MULTI_AGENT_DESIGN.md` | 多智能体协作设计 → 第四章、第八章 | ✅ 已清理 |
| `HEARTBEAT_DESIGN.md` | 心跳方案 → 第九章 | ✅ 已清理 |
| `CONFIG_GUIDE.md` | 配置体系 → 第七章 | ✅ 已清理 |
| `CONFIG_GITIGNORE.md` | 安全注意 → 第七章 | ✅ 已清理 |
| `IMPROVEMENT_GUIDE.md` | 待实现功能 → 第十一章 | ✅ 已清理 |
| `docs/AGENT_TO_AGENT_AUTONOMY.md` | 自驱校验架构 → 第八章 | ✅ 已清理 |
| `docs/EXECUTION_GUARD.md` | 执行引擎设计 → 第八章 | ✅ 已清理 |
| `docs/WEB_UI_AGENT_INTEGRATION.md` | Web UI 融合 → 第九章 | ✅ 已清理 |
| `framework/README.md` | 框架使用 → 项目结构 | ✅ 已清理 |
| `framework/llm/README.md` | LLM 配置 → 第七章 | ✅ 已清理 |
| `sdk/README.md` | SDK 使用 → 第六章 | ✅ 已清理 |
| `skills/hermes-todo-skill/SKILL.md` | Skill 使用 → 第六章 | ✅ 已清理 |

> 最后更新：2026-05-04 - 新增 ValidationAgent Agent Loop、Provider tools 支持、maxTokens 升级、Agent 架构演进路线、LLM Provider 热插拔

---

## 十五、改进建议

### 15.1 P0 紧急（影响正确性/安全性）

1. **认证中间件 timing-safe 比较**：当前 `===` 比较 secret_key 存在 timing attack 风险
2. **MemoryManager 内存存储脆弱性**：依赖 `localStorage`（Node.js 不存在），重启即丢失
3. **输入验证缺失**：路由层缺乏系统性输入校验
4. **DriveOrchestrator 缺乏实时多步推理**：当前 `driveTask()` 中 LLM 生成命令后执行，但执行结果不反馈到同一轮 LLM 推理中——只有失败重试时才通过 `retryContext` 传递。这意味着 Agent Loop 无法在单次驱动中根据命令执行结果调整策略。

### 15.2 P1 高优先级（影响性能/可维护性）

5. **Framework.js 单体职责过重**：~800行承担多个职责
6. **ConfigLoader 脆弱的配置搜索**：依赖 `require.main.filename`
7. **缺少速率限制**：所有 API 无速率限制
8. **缺少 Token 预算控制**：LLM 调用无 token 累计和预算限制，可能导致成本失控
9. **9 个定时器硬编码在 server.js**：全部 `setInterval`，无统一调度器，单进程重复执行风险
10. **命令提取依赖正则**：`CommandExecutor` 用 `BLOCK_REGEX`/`LINE_CMD_REGEX` 提取命令，脆弱且需要维护 80+ 个 `INVALID_PREFIXES` 黑名单

### 15.3 P2 中优先级（影响质量/工程规范）

11. **数据库迁移策略需优化**：逐个 try/catch ALTER TABLE 无法回滚
12. **缺乏 API 文档**：仅有路由列表，无请求/响应示例
13. **错误处理不一致**：混用多种错误处理方式
14. **测试覆盖率待提升**：Express 路由层、SDK 等未覆盖
15. **Agent 间无消息传递通道**：只有任务指派和通知，缺乏双向对话能力
16. **所有 Agent 共享 LLM 配置**：无法为不同 Agent 配置不同模型或参数
17. **StructuredDriveTools 未被 DriveOrchestrator 主循环使用**：只在 `Framework.processMessage()` 中可选使用

### 15.4 V1.2 架构演进路线（Agent Loop 核心能力提升）

#### 15.4.1 A 组：Agent Loop 核心能力增强

**A1. DriveOrchestrator ReAct Agent Loop 升级**（投入产出比最高）

当前问题：
```
LLM → 提取命令 → 执行 → 存结果 → 下一轮 retry 才能看到
```

目标架构：
```
while (not done and iterations < MAX):
    1. LLM 观察当前状态（任务信息 + 历史命令结果 + 上下文）
    2. LLM 决定下一步行动（调用工具 or 宣布完成）
    3. 执行工具，结果立即反馈到下一步
    4. 判断是否完成/阻塞/需要验证
```

具体改动：
- `DriveOrchestrator.driveTask()` 引入 Agent Loop，每轮执行完命令后将结果 push 到 messages 中
- 定义完整工具集：`execute_command`、`read_file`、`update_progress`、`propose_completion`、`ask_for_help`
- 用 StructuredDriveTools 替代正则命令提取
- 每轮 LLM 能看到之前所有命令的执行结果，实现真正的 ReAct 模式

**A2. ValidationAgent 增强自我反思**

- 添加 `reflect` 工具让 LLM 每 3 轮自我评估"证据是否足够"
- 添加证据置信度评分，低置信度触发额外验证

**A3. Token 预算控制**

- LLMManager 添加 `usageTracker`，累计每次调用的 token 消耗
- 为每个 Agent Loop 设置 token 预算上限（如 driveTask: 50k, validation: 80k）
- 超预算时优雅降级（返回当前最佳判断）

#### 15.4.2 B 组：架构改进

**B1. 统一调度器**（SchedulerFramework）

将 server.js 中 9 个 `setInterval` 迁移到统一 Scheduler 类：
- 统一管理定时器生命周期
- 配置不同 job 的优先级和互斥关系
- 方便测试和调试，为后续分布式调度做准备

**B2. Agent 配置隔离**

- `config.json` 为默认配置
- 每个 Agent 可有自己的 LLM 配置（模型、温度、maxTokens）
- `LLMManager` 根据 `agentId` 加载对应配置

**B3. Agent 间消息总线**

添加 `agent_messages` 表，支持双向对话、任务讨论、验证反馈。比当前 `task_notifications` 更灵活。

#### 15.4.3 C 组：长期演进

**C1. Streaming 响应支持** — Dashboard SSE + Agent Worker 边生成边执行
**C2. 可观测性增强** — OpenTelemetry 追踪 + 审计日志 + Dashboard 调用链路可视化
**C3. 插件化工具系统** — 工具注册表 + Agent 按任务类型动态加载工具

### 15.5 实施优先级建议

| 优先级 | 项目 | 预估工作量 | 预期收益 |
|--------|------|-----------|---------|
| 🔴 最高 | A1: ReAct Agent Loop 升级 | 2-3 天 | 直接提升任务完成率 |
| 🔴 高 | A3: Token 预算控制 | 1-2 天 | 防止成本失控和无限循环 |
| 🟡 中 | B1: 统一调度器 | 1-2 天 | 解决 server.js 800 行定时器泥潭 |
| 🟡 中 | 任务优先级管理机制 | 1-2 天 | 防止验证任务被抢占 |
| 🟢 低 | B2: Agent 配置隔离 | 0.5 天 | 不同 Agent 用不同模型 |
| 🟢 低 | C1: Streaming 支持 | 2-3 天 | 提升用户体感 |
