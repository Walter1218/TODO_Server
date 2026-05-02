# Agent TODO Server

智能体任务管理服务 —— 帮助 AI Agent 管理任务、减少上下文膨胀、实现多智能体协作。

## 🎯 项目概述

### 核心问题
- 智能体在长对话中上下文窗口膨胀
- 多次复杂任务后出现任务发散
- 历史信息淹没关键任务
- 多智能体之间任务不透明、无法协作

### 解决方案
- **外部化任务记忆**：任务状态持久化到 SQLite，agent 重启不丢失
- **聚焦引擎**：自动选择最优任务，注入上下文
- **心跳追踪**：实时监控任务执行进度和阻塞
- **多智能体协作**：任务指派、转交、跨 agent 通知
- **验收标准**：LLM 生成检查清单，用户确认后执行
- **自动运维监控**：`StuckMonitor`、`DriveOrchestrator` 与 `ValidatorService` 协同工作，实现无人值守的任务修复与验收。
- **Agent-to-Agent 自驱校验**：Worker 执行，Validator 验收，Orchestrator 编排，彻底跳出 Human-in-the-loop。

## 🚀 快速开始

### 1. 安装

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

### 2. 配置

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
      "model": "MiniMax-M2.7"
    }
  },
  "agent": {
    "id": "your-agent-id",
    "name": "我的智能体"
  }
}
```

### 3. 启动与管理 (守护进程模式)

推荐使用 PM2 管理集群，支持后台运行、自动重启和日志监控：

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

**传统启动方式 (仅用于调试)：**
```bash
# 启动 TODO Server API
npm start

# 启动框架客户端 (需手动指定配置)
node start.js --config config.hermes-coder.json
```

### 4. 部署 Hermes Skill
如果需要使用 Hermes 接入，运行以下命令同步 Skill 到本地 Hermes 目录：
```bash
npm run setup:hermes
```
> 此命令会自动注册智能体、同步凭证并部署最新的 Python Skill。

## 📁 项目结构

```
TODO_Server/
├── src/                          # TODO Server API
│   ├── server.js                 # Express 服务器入口 + 认证中间件
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
│   │   └── notifications.js      # 通知管理
│   └── services/
│       ├── CommandExecutor.js    # 命令提取与执行
│       ├── DriveOrchestrator.js  # 自动化任务驱动器
│       ├── ProgressValidator.js  # 任务进展验证器
│       ├── ValidatorService.js   # Agent-to-Agent 自动化校验服务
│       ├── ValidationDispatchService.js # 第三方验证任务派发服务
│       └── TaskReportService.js  # 任务流程报告生成服务
│   └── utils/
│       └── driveHelper.js        # 手动驱动任务辅助（Prompt 构建）
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
│   ├── utils/ConfigLoader.js     # 配置加载器
│   └── examples/                 # 集成示例
├── skills/
│   └── hermes-todo-skill/        # Hermes Skill 接入层
│       ├── SKILL.md              # Skill 定义
│       ├── todo_skill.py         # Python CLI
│       ├── todo_skill_config.yaml
│       └── agents.yaml           # Profile → Agent 凭证映射
├── scripts/
│   └── setup.js                  # 安装向导
├── public/                       # Web 管理界面
├── data/                         # SQLite 数据库（自动创建，已 gitignore）
├── logs/                         # 日志目录（自动创建，已 gitignore）
├── .env                          # 环境变量（setup 生成，已 gitignore）
├── .env.example                  # 环境变量模板
├── config.json                   # 框架配置（setup 生成，已 gitignore）
├── config.example.json           # 配置示例
├── start.js                      # 框架客户端启动脚本
└── agent-worker.js               # Worker 执行模式入口
```

## 🎯 核心功能

### 1. 任务管理
- 创建 / 更新 / 删除 / 查询
- 4 级优先级：`critical` / `high` / `medium` / `low`
- 标签系统、上下文字段、位置排序
- 子任务（`parent_id`）+ 自动完成父任务检测
- 任务搜索（标题/描述/上下文模糊匹配）

### 2. 依赖管理
- 任务间依赖关系
- 循环依赖检测（DFS 算法）
- 可执行任务筛选（依赖已满足）
- 依赖树查询

### 3. 聚焦引擎（Focus Engine）
```http
POST /api/agents/:id/focus/auto
```
**LLM 增强自动选优**：
- 多个候选任务时，LLM 综合紧急程度、完成难度、依赖关系、风险评估选择最优任务
- 单候选或无 LLM 时，回退到评分算法：`score = priority_weight(critical=100) + age_bonus(max 20) + ready_bonus(max 30) - retry_penalty`
- 每次任务创建/完成/状态变更后自动重新评估聚焦

### 3a. LLM 任务状态推断
```http
GET /api/agents/:id/focus
```
**工作状态分析**（`buildWorkAnalysis`）：
- 优先复用 `LLMInferencer` 后台推断结果（5 分钟缓存），避免重复调用 LLM
- 无缓存时实时发起 LLM 分析：判断智能体是否在工作、当前动作、建议状态
- LLM 不可用时自动回退到阈值规则引擎（idle 时间 + blocker 状态 + 上下文活动）
- `LLMInferencer` 后台每 5 分钟扫描 idle 5-15 分钟的任务，高置信度（≥0.75）时自动标记 completed/blocked

### 4. 心跳与重试追踪
```http
POST /api/agents/:id/todos/:id/heartbeat
```
- 每 5 分钟上报进度、当前步骤、阻塞项
- 超过 30 分钟无心跳 → 自动标记为 stuck
- 超过最大重试次数（默认 3）→ 自动标记为 `blocked`

### 5. 验收标准与自驱校验
- **验收清单**：LLM 自动生成结构化验收清单，用户确认后开始执行。
- **自驱验收**：Worker 完成任务后调用 `proposeCompletion()`，状态转为 `pending_validation`。
- **第三方验证**：`ValidationDispatchService` 自动派发验证任务给指定智能体，避免自我验证。
- **防重复机制**：基于 `Todo.findByTitle()` 防止同一任务重复创建验证任务。
- **自动质检**：`ValidatorService` 自动读取执行上下文并进行 LLM 审计，通过则标记 `completed`，失败则打回并附带改进建议。
- **任务流程报告**：验证完成后自动生成任务报告，包含基本信息、执行记录、验证记录和时间线，支持 JSON 和 Markdown 格式。
- **网页端报告查看**：支持在任务详情中直接查看和下载任务报告。

### 6. 漂移检测（Drift Detection）
- LLM 语义分析对话是否偏离当前任务
- `drift_score >= 0.6` 时主动提醒，提供 3 个选项：
  - `[A]` 回到原任务
  - `[B]` 记录为新任务
  - `[C]` 暂停当前任务

### 7. 多智能体协作
| 能力 | API |
|------|-----|
| 指派任务 | `POST /todos/:id/assign` |
| 转交任务 | `POST /todos/:id/transfer` |
| 我创建的任务 | `GET /todos/created` |
| 指派给我的 | `GET /todos/assigned` |
| 跨 agent 通知 | `GET /notifications` |
| 项目全局看板 | `GET /projects/:id/board` |
| 自动创建被指派 agent | 指派时自动注册不存在的 agent |

### 8. 定时调度任务（统一调度架构）
- 任务模板（`is_template=true`）+ 调度规则（`schedule`）
- 支持格式：`daily`、`weekly:mon,fri`、`cron:0 9 * * *`
- **模板 → 实例**：DailyScheduler 每分钟检查到期模板，自动 spawn 实例（`parent_id` 指向模板）
- **实例 → 报告**：Hermes cron job 通过 `GET /todos/scheduled/pending` 查询待执行实例，执行完通过 `POST /todos/:id/report` 写入结果
- spawn 时自动创建 `task_notification`（assigned 类型），通知 agent 有新实例待执行
- 手动触发模板实例化：`POST /todos/:id/spawn`

### 9. 手动驱动执行
```http
POST /api/agents/:id/todos/:id/drive
```
- 强行触发 LLM 执行指定任务
- 支持恢复 blocked 任务（自动增加重试计数）
- 自动生成 Work Prompt + 解析回复更新心跳

### 10. 对话上下文存储
```http
POST /api/agents/:id/contexts      # 存储消息
GET  /api/agents/:id/contexts      # 按 session 查询
GET  /api/agents/:id/contexts/summary  # 会话摘要
```

### 11. 自动运维监控
- **StuckTaskMonitor**：每 3 分钟自动扫描，基于动态阈值（预估耗时 × 进度 × 0.5）检测无心跳任务，自动恢复或标记 blocked
- **AssignmentDriver**：指派/转交后立即 auto-focus 到目标 agent；每 60 秒兜底扫描已指派但超过 5 分钟仍为 `pending` 的任务，自动强制 focus + 通知
- **DriveOrchestrator**：每 60 秒扫描所有有 focus 的任务，自动 drive（LLM 推理 + bash 执行） + ProgressValidator 验证；
- **ValidatorService**：检测到 `pending_validation` 任务时自动执行异步校验逻辑，闭环 Agent-to-Agent 协作。
- **LLMInferencer**：每 5 分钟扫描 idle 5-15 分钟的任务，LLM 推断真实状态（completed/blocked/in_progress），置信度 ≥0.75 自动执行
- **WorkSnapshotMonitor**：每 30 秒采集工作快照到 contexts
- **CleanupMonitor**：每天自动归档超过 30 天的 `completed`/`cancelled` 任务（软删除，`archived=1`）
- **DailyScheduler**：每分钟检查到期的模板任务并生成实例
- **手动管理**：`POST /archive-old?days=30` 手动归档，`DELETE /archived` 物理清理已归档任务

### 12. 项目看板
```http
GET /api/agents/:id/projects/:id/board
```
按执行 agent 分组，显示总体进度、各 agent 任务数。

## 📡 API 速查

### 智能体
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agents` | 注册智能体 |
| GET | `/api/agents/:id` | 查询智能体 |
| DELETE | `/api/agents/:id` | 删除智能体 |

### 任务
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
| GET | `/api/agents/:id/todos/:id/report` | 获取任务流程报告 |
| POST | `/api/agents/:id/todos/:id/sub-tasks` | 创建子任务 |
| GET | `/api/agents/:id/todos/:id/subtasks` | 获取子任务 |
| GET | `/api/agents/:id/todos/:id/dependency-tree` | 依赖树 |
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

### 聚焦
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/agents/:id/focus` | 当前聚焦 |
| PUT | `/api/agents/:id/focus` | 手动设置聚焦 |
| POST | `/api/agents/:id/focus/auto` | 自动聚焦 |

### 项目
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agents/:id/projects` | 创建项目 |
| GET | `/api/agents/:id/projects` | 列出项目 |
| GET | `/api/agents/:id/projects/:id` | 获取项目 |
| GET | `/api/agents/:id/projects/:id/board` | 项目看板 |

### 通知
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/agents/:id/notifications` | 获取通知 |
| POST | `/api/agents/:id/notifications/:id/read` | 标记已读 |
| POST | `/api/agents/:id/notifications/read-all` | 全部已读 |

### 上下文
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agents/:id/contexts` | 存储消息 |
| GET | `/api/agents/:id/contexts` | 查询消息 |
| GET | `/api/agents/:id/contexts/summary` | 会话摘要 |

## 🔌 SDK 使用

### JavaScript SDK

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
console.log('当前聚焦:', data.task.title);

// 更新心跳
await sdk.updateHeartbeat(taskId, {
  progress: 50,
  step: '编写数据层',
  blockers: ['等待API文档']
});

// 多智能体协作
await sdk.assignTask(taskId, 'hermes-ops', { note: '请部署到生产环境' });
await sdk.transferTask(taskId, 'hermes-coder', { note: '需要代码审查' });
const notifications = await sdk.getNotifications(true); // 仅未读
```

### Python CLI（Hermes Skill）

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

# 查看通知
python3 ~/.hermes/skills/hermes-todo-skill/todo_skill.py notifications
```

## 🤖 Hermes 集成

### Skill 挂载

TODO Skill 已同步到所有 Hermes profile：
- `~/.hermes/profiles/default/skills/hermes-todo-skill`
- `~/.hermes/profiles/ops/skills/hermes-todo-skill`
- `~/.hermes/profiles/coder/skills/hermes-todo-skill`

### 凭证映射

`~/.hermes/skills/hermes-todo-skill/agents.yaml`：

```yaml
agents:
  default:
    agent_id: <uuid>
    secret_key: <key>
  ops:
    agent_id: <uuid>
    secret_key: <key>
  coder:
    agent_id: <uuid>
    secret_key: <key>
```

Skill 根据 `HERMES_HOME` 环境变量自动匹配 profile，无需手动切换。

## 📊 功能矩阵

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
| 漂移检测 | - | - | ✅ | - | LLM 语义分析 |
| 多智能体指派 | ✅ | ✅ | - | ✅ | 跨 agent + 自动创建 |
| 跨 agent 通知 | ✅ | ✅ | - | ✅ | assigned/transferred |
| 上下文存储 | ✅ | ✅ | ✅ | ✅ | 按 session |
| 上下文智能排序 | - | - | ✅ | - | LLM 综合排序 + 规则兜底 |
| 定时调度 | ✅ | ✅ | - | - | 模板 spawn → cron 执行 → report 写入（统一架构） |
| 手动驱动 | ✅ | - | ✅ | - | LLM 执行 + 恢复 |
| 自动运维监控 | ✅ | - | - | - | StuckMonitor + LLMInferencer + Snapshot + AssignmentDriver + DriveOrchestrator |
| 任务归档清理 | ✅ | - | - | - | 软删除 + 自动归档 |
| 熔断 + 本地缓存 | - | - | ✅ | - | 3 次失败降级 |
| LLM 集成 | ✅ | - | ✅ | - | Server 聚焦/推断 + Framework 全模块 |
| 角色模板系统 | - | - | ✅ | - | 通用/编码/分析/DevOps |
| 记忆管理 | - | - | ✅ | - | 提取 + 自动摘要 |
| 任务自动发现 | - | - | ✅ | - | LLM 对话分析 + 确认创建 |
| 上下文注入 | - | - | ✅ | - | LLM 增强 prompt 构建 |

## 📖 关联文档

| 文档 | 说明 |
|------|------|
| [CONFIG_GUIDE.md](CONFIG_GUIDE.md) | 框架客户端配置详解 |
| [AGENT_INTEGRATION.md](AGENT_INTEGRATION.md) | Agent SDK 接入指南 |
| [IMPROVEMENT_GUIDE.md](IMPROVEMENT_GUIDE.md) | 项目改进建议（P0-P3 优先级） |
| [HERMES_INTEGRATION_DESIGN.md](HERMES_INTEGRATION_DESIGN.md) | Hermes 集成架构设计 |
| [MULTI_AGENT_DESIGN.md](MULTI_AGENT_DESIGN.md) | 多智能体协作设计 |
| [TODO_ROADMAP.md](TODO_ROADMAP.md) | 剩余工作清单 |

## 📈 版本进度

### 已完成 ✅

- [x] TODO Server 完整 REST API（30+ 路由）
- [x] SQLite 数据库 + WAL 模式 + 自动迁移
- [x] Agent 认证（secret_key）+ 跨 agent 操作
- [x] JavaScript SDK（完整 CRUD + 协作 + 调度）
- [x] 聚焦引擎（Focus Engine）自动选优 + 状态变更自动重评估
- [x] 心跳追踪（Heartbeat）+ 卡住检测
- [x] 重试管理（attempt_count / max_attempts）
- [x] 验收标准生成 + 显式确认
- [x] 漂移检测 + 主动提醒
- [x] 任务自动发现 + 用户确认创建
- [x] 多智能体协作（指派 / 转交 / 通知 + 自动创建被指派 agent）
- [x] 项目全局看板（跨 agent 统计）
- [x] 对话上下文存储 + 会话摘要
- [x] 定时调度统一架构（模板 spawn → parent_id 链接 → cron report 写入）
- [x] 手动驱动执行（LLM 执行 + 恢复 blocked 任务）
- [x] 循环依赖检测（DFS 算法修复）
- [x] 熔断 + 本地缓存降级
- [x] LLM Provider 抽象层（MiniMax / OpenAI / Anthropic / Ollama）
- [x] 主备 LLM 自动切换
- [x] 角色模板系统（通用/编码/分析/DevOps）
- [x] 记忆管理（提取 + 自动摘要 + 过期清理）
- [x] LLM 全模块集成（聚焦选优 / 工作状态推断 / 上下文排序 / 自动运维推断）
- [x] AssignmentDriver 指派任务自动驱动（即时 auto-focus + 60s 兜底巡检）
- [x] ExecutionGuard 执行守卫（CommandExecutor + ProgressValidator + DriveOrchestrator 闭环执行引擎）
- [x] Hermes Skill 接入框架（Python CLI）
- [x] Profile 感知自动匹配凭证
- [x] `npm run setup` 一键安装向导
- [x] Agent 接入指南文档（AGENT_INTEGRATION.md）
- [x] Worker 执行模式（agent-worker.js）
- [x] 核心功能单元测试（98 用例，覆盖 Todo/Focus/Agent/Config/Prompt/Memory）
- [x] LLMInferencer 后台推断 + 动态阈值 StuckMonitor + WorkSnapshot
- [x] Hermes Unified Scheduling 自动接入（postinstall patch + `npm run patch:hermes`）
- [x] 任务 title 去重机制（409 Conflict + existing_task 返回）

### 进行中 🔄

- [ ] WebSocket 实时推送（任务状态变更）
- [ ] 可视化管理界面

### 计划中 📋

- [ ] Docker / Docker Compose 部署
- [ ] Python SDK
- [ ] 任务评论 / 协作讨论
- [ ] 任务版本控制 / 历史回滚

## 🔧 开发

```bash
# 启动开发服务器（热重载）
npm run dev

# 运行全部单元测试
npm test

# 查看测试覆盖率报告
npm run test:coverage

# 运行框架示例
node framework/examples/ProgressiveIntegration.js

# 查看数据库
sqlite3 data/todo.db ".tables"
```

## 📝 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `DB_PATH` | `./data/todo.db` | SQLite 数据库路径 |
| `LOG_LEVEL` | `info` | 日志级别 |
| `NODE_ENV` | `development` | 运行环境 |

## 📄 License

MIT
