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
- **漂移检测**：自动发现对话偏离当前任务，主动提醒

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

### 3. 启动

```bash
# 启动 TODO Server API
npm start

# 开发模式（热重载）
npm run dev

# 启动框架客户端（需要配置 LLM）
npm run agent
```

**启动后验证：**
```bash
curl http://localhost:3000/health
# 预期: {"status":"ok","timestamp":"...","uptime":...}
```

## 📁 项目结构

```
TODO_Server/
├── src/                          # TODO Server API
│   ├── server.js                 # Express 服务器入口
│   ├── db.js                     # SQLite 数据库（WAL 模式）
│   ├── middleware/
│   │   └── auth.js               # Agent 认证中间件
│   ├── models/                   # 数据模型
│   │   ├── Agent.js              # 智能体 CRUD + secret_key
│   │   ├── Todo.js               # 任务 CRUD + 协作方法
│   │   ├── Project.js            # 项目 CRUD
│   │   ├── FocusState.js         # 聚焦状态管理
│   │   ├── Context.js            # 对话上下文存储
│   │   └── Notification.js       # 跨 agent 通知
│   └── routes/                   # API 路由
│       ├── agents.js             # 智能体注册
│       ├── todos.js              # 任务 CRUD + 指派/转交
│       ├── projects.js           # 项目 + 全局看板
│       ├── focus.js              # 聚焦引擎
│       ├── contexts.js           # 上下文存储
│       └── notifications.js      # 通知管理
├── sdk/
│   └── agent-todo-sdk.js         # JavaScript SDK
├── framework/                    # 可选：内置框架客户端
│   ├── core/Framework.js         # 主框架（LLM 驱动）
│   ├── modules/
│   │   ├── TaskManager.js        # 任务管理
│   │   ├── ContextManager.js     # 上下文管理
│   │   ├── MemoryManager.js      # 记忆管理
│   │   ├── PromptManager.js      # Prompt 增强
│   │   └── ProactiveManager.js   # 主动交互 + 漂移检测
│   └── utils/ConfigLoader.js     # 配置加载器
├── scripts/
│   └── setup.js                  # 安装向导
├── skills/
│   └── hermes-todo-skill/        # Hermes Skill 接入层
│       ├── SKILL.md              # Skill 定义
│       ├── todo_skill.py         # Python CLI
│       ├── todo_skill_config.yaml
│       └── agents.yaml           # Profile → Agent 凭证映射
├── public/                       # Web 管理界面（可选）
├── data/                         # SQLite 数据库（自动创建）
├── logs/                         # 日志目录（自动创建）
├── .env                          # 环境变量（setup 生成）
├── .env.example                  # 环境变量模板
├── config.json                   # 框架配置（setup 生成）
├── config.example.json           # 配置示例
└── start.js                      # 框架客户端启动脚本
```

## 🎯 核心功能

### 1. 任务管理
- 创建 / 更新 / 删除 / 查询
- 4 级优先级：`critical` / `high` / `medium` / `low`
- 标签系统、上下文字段、位置排序
- 子任务（`parent_id`）+ 自动完成父任务检测

### 2. 依赖管理
- 任务间依赖关系
- 循环依赖检测
- 可执行任务筛选（依赖已满足）

### 3. 聚焦引擎（Focus Engine）
```http
POST /api/agents/:id/focus/auto
```
自动选择最优任务，评分算法：
```
score = priority_weight(critical=100) + age_bonus(max 20) + ready_bonus(max 30) - retry_penalty
```

### 4. 心跳与重试追踪
```http
POST /api/agents/:id/todos/:id/heartbeat
```
- 每 5 分钟上报进度、当前步骤、阻塞项
- 超过 30 分钟无心跳 → 自动标记为 stuck
- 超过最大重试次数（默认 3）→ 自动标记为 `blocked`

### 5. 验收标准流程
- LLM 自动生成结构化验收清单
- 用户显式确认后（`criteria_confirmed=true`）才能执行
- 完成时展示检查清单，用户确认后才标记完成

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

### 8. 对话上下文存储
```http
POST /api/agents/:id/contexts      # 存储消息
GET  /api/agents/:id/contexts      # 按 session 查询
```

### 9. 项目看板
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
| GET | `/api/agents/:id/todos/:id/subtasks` | 获取子任务 |
| GET | `/api/agents/:id/todos/assigned` | 指派给我的 |
| GET | `/api/agents/:id/todos/created` | 我创建的 |
| GET | `/api/agents/:id/todos/stuck/list` | 卡住的任务 |

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
| 依赖关系 | ✅ | ✅ | ✅ | ✅ | + 循环检测 |
| 项目分组 | ✅ | ✅ | ✅ | ✅ | + 看板 |
| 聚焦引擎 | ✅ | ✅ | ✅ | ✅ | 自动选优 |
| 心跳追踪 | ✅ | ✅ | - | ✅ | 5min 间隔 |
| 重试管理 | ✅ | ✅ | - | ✅ | 3 次上限 |
| 验收标准 | ✅ | ✅ | ✅ | ✅ | LLM 生成 + 确认 |
| 漂移检测 | - | - | ✅ | - | LLM 语义分析 |
| 多智能体指派 | ✅ | ✅ | - | ✅ | 跨 agent |
| 跨 agent 通知 | ✅ | ✅ | - | ✅ | assigned/transferred |
| 上下文存储 | ✅ | ✅ | ✅ | ✅ | 按 session |
| 熔断 + 本地缓存 | - | - | ✅ | - | 3 次失败降级 |
| LLM 集成 | - | - | ✅ | - | MiniMax/OpenAI/Claude |

## 📖 关联文档

| 文档 | 说明 |
|------|------|
| [CONFIG_GUIDE.md](CONFIG_GUIDE.md) | 框架客户端配置详解 |
| [AGENT_INTEGRATION.md](AGENT_INTEGRATION.md) | Agent SDK 接入指南 |
| [HERMES_INTEGRATION_DESIGN.md](HERMES_INTEGRATION_DESIGN.md) | Hermes 集成架构设计 |
| [MULTI_AGENT_DESIGN.md](MULTI_AGENT_DESIGN.md) | 多智能体协作设计 |
| [TODO_ROADMAP.md](TODO_ROADMAP.md) | 剩余工作清单 |

## 📈 版本进度

### 已完成 ✅

- [x] TODO Server 完整 REST API
- [x] SQLite 数据库 + WAL 模式 + 安全迁移
- [x] Agent 认证（secret_key）+ 跨 agent 操作
- [x] JavaScript SDK（完整 CRUD + 协作）
- [x] 聚焦引擎（Focus Engine）自动选优
- [x] 心跳追踪（Heartbeat）+ 卡住检测
- [x] 重试管理（attempt_count / max_attempts）
- [x] 验收标准生成 + 显式确认
- [x] 漂移检测 + 主动提醒
- [x] 任务自动发现 + 用户确认创建
- [x] 多智能体协作（指派 / 转交 / 通知）
- [x] 项目全局看板（跨 agent 统计）
- [x] 对话上下文存储
- [x] 熔断 + 本地缓存降级
- [x] Hermes Skill 接入框架（Python CLI）
- [x] Profile 感知自动匹配凭证
- [x] `npm run setup` 一键安装向导

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
