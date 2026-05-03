# Agent TODO Server 项目文档

> 最后更新：2026-05-02
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
│   │   └── notifications.js      # 通知管理
│   └── services/
│       ├── CommandExecutor.js    # 命令提取与执行
│       ├── DriveOrchestrator.js  # 自动化任务驱动器
│       ├── ProgressValidator.js  # 任务进展验证器
│       ├── ValidatorService.js   # Agent-to-Agent 自动化校验服务
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
- **第三方验证**（可选）：通过 `ValidationDispatchService` 派发独立验证任务给另一个 Agent（如 hermes-ops），由第三方 Agent 独立调查并通过 `/validation-report` API 提交验证报告
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

| 监控模块 | 功能 |
|---------|------|
| StuckTaskMonitor | 每 3 分钟自动扫描，基于动态阈值检测无心跳任务 |
| AssignmentDriver | 指派/转交后立即 auto-focus 到目标 agent |
| DriveOrchestrator | 每 60 秒扫描所有有 focus 的任务，自动 drive + 验证 |
| ValidatorService | 检测到 `pending_validation` 任务时自动执行异步校验 |
| LLMInferencer | 每 5 分钟扫描 idle 5-15 分钟的任务，LLM 推断真实状态 |
| WorkSnapshotMonitor | 每 30 秒采集工作快照到 contexts |
| CleanupMonitor | 每天自动归档超过 30 天的 `completed`/`cancelled` 任务 |
| DailyScheduler | 每分钟检查到期的模板任务并生成实例 |

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
    "minimax": { "apiKey": "", "model": "MiniMax-Text-01" },
    "openai": { "apiKey": "", "model": "gpt-3.5-turbo" },
    "anthropic": { "apiKey": "", "model": "claude-3-5-haiku-20241022" }
  },
  "agent": { "id": "", "name": "" },
  "features": {
    "taskManagement": { "enabled": true },
    "contextManagement": { "enabled": true },
    "memoryManagement": { "enabled": false },
    "promptManagement": { "enabled": true },
    "proactiveInteraction": { "enabled": true },
    "dependencyManagement": { "enabled": true }
  }
}
```

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

---

## 九、典型案例分析：stk_limit 补采任务

### 9.1 案例背景

任务「**A股 stk_limit 补采到 2026-04-30**」是一个典型的数据补采任务，用于同步涨跌停限制数据。该任务在执行过程中经历了完整的自驱校验流程，并最终失败，为我们提供了宝贵的改进机会。

### 9.2 任务详情

| 属性 | 内容 |
|------|------|
| 标题 | A股 stk_limit 补采到 2026-04-30 |
| 状态 | `validation_failed` |
| 优先级 | medium |
| 尝试次数 | 3/3 |
| 创建时间 | 2026-05-02 10:53:39 |
| 任务 ID | `99907e7e-2792-465e-ac62-2947b4c59abe` |

### 9.3 任务描述

```
当前 DuckDB fact_stk_limit 只到 2026-03-20（735,327行），需要补采到 2026-04-30。

步骤：
1. kill $(lsof -ti /Users/onetwo/.openclaw/workspace/tushare_warehouse/data/tushare_stklimit.duckdb) 2>/dev/null
2. cd /Users/onetwo/.openclaw/workspace/tushare_warehouse && TUSHARE_API_TOKEN="xxx" /opt/homebrew/bin/python3 -u scripts/fetch_stk_limit.py
3. 验证：duckdb /Users/onetwo/.openclaw/workspace/tushare_warehouse/data/tushare_stklimit.duckdb -c "SELECT MIN(trade_date), MAX(trade_date), COUNT(*) FROM fact_stk_limit"
预期结果：MAX(trade_date) = 2026-04-30
```

### 9.4 执行过程

1. **第一次执行**：Agent 收到任务，但未执行任何命令
2. **第二次执行**：Agent 尝试执行命令但失败，duckdb 命令不可用
3. **第三次执行**：脚本执行后无验证，progress 达到 100% 但未通过验收

### 9.5 失败原因分析

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

### 9.6 问题根因

1. **环境问题**：duckdb 命令在当前环境不可用，应使用 Python + duckdb 库替代
2. **命令提取机制单一**：仅支持代码块格式，无法从任务描述中提取命令
3. **缺乏自动重试机制**：校验失败后任务停留在 `validation_failed` 状态，已达到最大尝试次数

### 9.7 改进措施（已实施）

| 改进项 | 文件 | 说明 |
|--------|------|------|
| 增强驱动 Prompt | `src/utils/driveHelper.js` | 添加明确的命令输出格式要求 |
| 扩展命令提取 | `src/services/CommandExecutor.js` | 支持从任务描述中提取步骤命令 |
| 支持 validation_failed 重试 | `src/services/DriveOrchestrator.js` | 自动重试并携带校验反馈给 LLM |
| 100%进度自动触发验证 | `src/services/DriveOrchestrator.js` | 进度达到100%时自动转为 pending_validation |
| 验证反馈传递给重试 | `src/services/DriveOrchestrator.js` | buildRetryContext 包含验证失败反馈 |
| 第三方验证机制 | `src/services/ValidationDispatchService.js` | 派发独立验证任务给第三方 Agent |

### 9.8 改进后的执行流程

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

### 9.9 经验教训

- 命令执行任务应优先使用 Python 库而非 shell 命令（如 duckdb 而非 duckdb CLI）
- 验证步骤必须作为命令的一部分执行，而不仅仅是在描述中说明
- 自动重试机制需要正确传递验证反馈给 LLM，避免重复相同错误

---

## 十、Web UI 与 Agent 任务融合

### 10.1 来源过滤

系统通过 `source` 字段区分任务来源（agent/human）：
- **Agent 任务**：非当前 agent 创建 OR 被指派给当前 agent
- **人类任务**：当前 agent 创建且未被指派

### 10.2 Web UI 保护措施

- 任务列表增加 🤖 Agent 标识（紫色背景）
- Agent 执行的任务**隐藏"强行驱动执行"按钮**
- 任务详情页区分来源

### 10.3 待实现功能

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P0 | 后端禁止修改 Agent 任务状态 | API 层校验来源，禁止人类修改 Agent 任务 |
| P1 | askForHelp 人类响应机制 | Web UI 增加"待响应"通知面板 |
| P2 | Agent 监控面板 | 一览所有 Agent 的活跃状态和任务执行情况 |

---

## 十一、功能矩阵

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
| 自驱校验 | ✅ | ✅ | - | ✅ | ValidatorService 内置 / ValidationDispatchService 第三方 |
| 多智能体指派 | ✅ | ✅ | - | ✅ | 跨 agent + 自动创建 |
| 跨 agent 通知 | ✅ | ✅ | - | ✅ | assigned/transferred |
| 上下文存储 | ✅ | ✅ | ✅ | ✅ | 按 session |
| 定时调度 | ✅ | ✅ | - | - | 模板 spawn → cron report |
| 手动驱动 | ✅ | - | ✅ | - | LLM 执行 + 恢复 |
| 自动运维监控 | ✅ | - | - | - | StuckMonitor + LLMInferencer + DriveOrchestrator |
| 任务归档清理 | ✅ | - | - | - | 软删除 + 自动归档 |
| 熔断 + 本地缓存 | - | - | ✅ | - | 3 次失败降级 |
| LLM 集成 | ✅ | - | ✅ | - | Server 聚焦/推断 + Framework 全模块 |
| 角色模板系统 | - | - | ✅ | - | 通用/编码/分析/DevOps |
| 记忆管理 | - | - | ✅ | - | 提取 + 自动摘要 |
| WebSocket 实时推送 | - | - | - | - | ❌ 待实现 |
| 可视化管理界面 | 部分 | - | - | - | 🔴 待完善 |
| Docker 部署 | - | - | - | - | ❌ 待实现 |
| 代码执行 Hook 心跳 | - | - | - | - | ❌ 待实现 |

---

## 十二、版本进度

### 12.1 已完成

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
- [x] 主备 LLM 自动切换
- [x] 角色模板系统（通用/编码/分析/DevOps）
- [x] 记忆管理（提取 + 自动摘要 + 过期清理）
- [x] LLM 全模块集成（聚焦选优 / 工作状态推断 / 上下文排序）
- [x] AssignmentDriver 指派任务自动驱动
- [x] DriveOrchestrator 全自动任务驱动引擎
- [x] ValidatorService Agent-to-Agent 自动化质检
- [x] StuckTaskMonitor 动态阈值卡住检测
- [x] LLMInferencer 后台智能状态推断
- [x] CleanupMonitor 自动归档超过 30 天的任务
- [x] Python CLI Skill（`propose-completion`）
- [x] Profile 感知自动匹配凭证
- [x] Skill 同步到所有 Hermes profile

### 11.2 待实现

| 优先级 | 功能 | 预估工作量 | 收益 |
|--------|------|-----------|------|
| P0 | 后端禁止修改 Agent 任务状态 | 0.5 天 | 高（安全性） |
| P1 | WebSocket 实时推送 | 1-2 天 | 中（体验提升） |
| P1 | 可视化管理界面完善 | 2-3 天 | 高（运维友好） |
| P1 | **任务优先级管理机制** | 1-2 天 | 高（防止验证任务被抢占） |
| P2 | askForHelp 人类响应机制 | 1 天 | 中（协作增强） |
| P2 | Agent 监控面板 | 1-2 天 | 中（可观测性） |
| P2 | 单元测试 + 集成测试 | 1-2 天 | 中（质量保障） |
| P2 | Docker Compose 部署 | 0.5 天 | 中（部署便利） |
| P3 | 代码执行 Hook 心跳 | 1 天 | 低（进度准确性） |

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
| **V1.1** | 🔄 计划 | + WebSocket + 可视化管理界面 + 后端保护 |
| **V1.2** | 📋 计划中 | + Docker + 单元测试 + Python SDK |

---

## 十五、已废弃文档

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

> 最后更新：2026-05-02 - 清理了 15 个已合并的过时文档

---

## 十六、改进建议

### 14.1 P0 紧急（影响正确性/安全性）

1. **认证中间件 timing-safe 比较**：当前 `===` 比较 secret_key 存在 timing attack 风险
2. **MemoryManager 内存存储脆弱性**：依赖 `localStorage`（Node.js 不存在），重启即丢失
3. **输入验证缺失**：路由层缺乏系统性输入校验

### 16.2 P1 高优先级（影响性能/可维护性）

4. **Framework.js 单体职责过重**：~800行承担多个职责
5. **ConfigLoader 脆弱的配置搜索**：依赖 `require.main.filename`
6. **缺少速率限制**：所有 API 无速率限制

### 16.3 P2 中优先级（影响质量/工程规范）

7. **数据库迁移策略需优化**：逐个 try/catch ALTER TABLE 无法回滚
8. **缺乏 API 文档**：仅有路由列表，无请求/响应示例
9. **错误处理不一致**：混用多种错误处理方式
10. **测试覆盖率待提升**：Express 路由层、SDK 等未覆盖
