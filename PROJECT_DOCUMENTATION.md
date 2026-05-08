# Agent TODO Server 项目文档

> 最后更新：2026-05-08
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
- **自愈机制 (Auto-Healing)**：任务阻塞 (Preflight失败/超时停滞) 时自动触发 LLM 诊断，自动派生 `[修复]` 子任务执行环境准备，修复完成后父任务自动恢复
- **Agent-to-Agent 自驱校验**：Worker 执行，Validator 验收，Orchestrator 编排，彻底跳出 Human-in-the-loop（支持第三方 Agent 独立验证）
- **LLM Agent Loop**：`ValidationAgent` 采用受限工具调用的轻量验证回路，默认最多 4 轮、单次预算 3000 token，优先走事实快速路径与规则校验，仅在证据不足时才使用 LLM 兜底
- **结构化驱动工具**：`StructuredDriveTools` 提供 `executeCommand`、`readFile`、`checkPath`、`updateProgress`、`proposeCompletion`、`confirmCompletion`、`askForHelp` 等结构化工具，已接入 `DriveOrchestrator` 的工具优先主循环，并保留 legacy fallback
- **复杂任务强制规划**：`TaskPlanService` 为复杂任务自动生成 `inspect -> execute -> verify` 三步计划，先过规则审查，再允许进入真实执行
- **按步骤强制推进**：`DriveOrchestrator` 已接入计划门禁；首次 drive 只完成 `inspect`，后续只允许在 `execute` 步骤推进，进入 `pending_validation/validating/completed` 后自动切到 `verify`
- **低 token 监督策略**：复杂任务计划生成、审查、步骤推进默认全部走规则和状态机，不把 LLM 放进高频监督链
- **任务分类与完成报告**：`task_category` 自动分类（inspection/script/code_change/general），`CompletionReportBuilder` 自动生成详细完成报告（数据位置、时间覆盖、完成度、产出物列表等）
- **孤儿子任务自动清理**：CleanupMonitor 自动检测父任务已完成但子任务仍在 pending/in_progress/blocked 的孤儿子任务并取消
- **Per-Agent 并发控制**：每个 Agent 可配置最大并发任务数（`max_concurrent_tasks`），Dispatch 全流程检查并发槽位
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
│       ├── CompletionReportBuilder.js   # 任务完成报告生成器（按类型自动构建）
│       ├── TaskPlanService.js    # 复杂任务计划生成/审查/步骤状态机
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
- 任务自动分类（`task_category`：inspection/script/code_change/general）
- 任务完成报告（`completion_report`：按类型自动生成详细报告）
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

**规则优先自动选优**：
- 多候选任务默认使用规则评分算法：`score = priority_weight(critical=100) + age_bonus(max 20) + ready_bonus(max 30) - retry_penalty`
- 每次任务创建/完成/状态变更后自动重新评估聚焦
- 不再为聚焦排序额外消耗 LLM 配额

**任务状态分析**：
- 默认使用规则引擎判断任务是否活跃、空闲、阻塞或可能卡住
- `focus` 路由默认关闭实时 LLM 状态分析，避免低价值高频推断持续消耗 token
- 仅在显式开启 `ENABLE_FOCUS_LLM_ANALYSIS=1` 时才允许该分析链路恢复

### 4.4 心跳与重试追踪

- 每 5 分钟上报进度、当前步骤、阻塞项
- 超过 30 分钟无心跳 → 自动标记为 stuck
- 超过最大重试次数（默认 3）→ 自动标记为 `blocked`
- 复杂任务额外记录 `requires_plan / plan_status / current_plan_id / current_step_id / execution_state / last_action_at`
- 当前计划底座表：`task_plans`、`task_plan_steps`、`task_events`

### 4.5 复杂任务强制规划与驱动

- **触发条件**：默认对 `hermes-default` 下的复杂任务，以及带 `task_spec` / 较长验收标准 / `script`、`code_change`、`inspection` 等高复杂度任务启用强制规划
- **计划生成**：系统自动生成 `inspect -> execute -> verify` 三步计划，写入 `task_plans` 与 `task_plan_steps`
- **规则审查**：在进入执行前检查高危删除命令、疑似生产数据库触达等安全红线；未通过时任务直接进入 `needs_revision/blocked`
- **步骤推进**：首次 drive 只完成 `inspect`；只有 `execute` 步骤会进入原有工具驱动链；进入 `pending_validation/validating/completed` 后自动切到 `verify`
- **修订闭环**：执行阻塞或验证失败时，系统会把任务标记为 `needs_revision`，同时写入 `task_events`，为后续受控修订保留入口
- **成本约束**：这套监督链默认不新增高频 LLM 请求，仍坚持规则优先、LLM 只用于真正需要的执行/排障/验证兜底

### 4.6 验收标准与自驱校验

- **验收清单**：LLM 自动生成结构化验收清单，用户确认后开始执行
- **自驱验收**：Worker 完成任务后调用 `proposeCompletion()`，状态转为 `pending_validation`
- **自动质检**：`ValidatorService` 自动读取执行上下文并进行 LLM 审计，通过则标记 `completed`，失败则打回并附带改进建议
- **ValidationAgent（内置 LLM Agent Loop）**：
  - **RESULT-FIRST 验证策略**：以任务实际产出（数据文件、数据库记录）为判定依据，禁止基于 Agent 运行状态（focus_task、idle）做判定
  - LLM + 工具调用的轻量 ReAct 模式，默认最多 4 轮迭代
  - 5 个工具：`exec_shell`、`read_duckdb`、`check_file`、`get_execution_logs`、`get_task_info`
  - **事实快速路径**：attempt_count=0 时先用工具检查 DuckDB 数据库、数据目录等实际产出物，有事实证据即通过，无证据才拒绝
  - **系统日志过滤**：`_getExecutionLogs` 过滤 14 种系统前缀（DriveOrchestrator、StuckTaskMonitor 等）和 14 种系统 metadata 类型，只返回 Agent 真正的执行日志
  - **强制判定兜底**：LLM 达到迭代上限未给出结论时，基于已有证据正/负面比例自动生成判定，避免迭代耗尽直接失败
  - **收敛规则**：第 2 轮开始强提醒收敛，第 3 轮为最后工具轮，第 4 轮只允许返回 JSON 判定
  - 工具安全约束：只读权限、危险命令过滤、沙箱路径限制、30s 超时、1000 字符截断
  - 单次调用预算默认 `maxTokens=3000`，并限制每轮最多 2 个工具调用，避免验证链空转打爆额度
- **第三方验证（可选，默认关闭）**：通过 `ValidationDispatchService` 派发独立验证任务给另一个 Agent（如 hermes-ops），由第三方 Agent 独立调查并通过 `/validation-report` API 提交验证报告
- **任务流程报告**：验证完成后自动生成任务报告，包含基本信息、执行记录、验证记录和时间线，支持 JSON 和 Markdown 格式
- **疑难咨询 / 自动排障建议**：`/consult` 与 `DriveOrchestrator.consultTask()` 已改为压缩摘要 prompt，只携带最近尝试、关键执行统计和短时间线，并限制单次 `maxTokens=1200`

### 4.7 多智能体协作

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
- **模板 → 实例**：DailyScheduler 每分钟按当前机器本地时间检查到期模板，自动 spawn 实例
- **本地时间基准**：`schedule` 与 cron 小时/星期字段统一基于当前运行机器的本地时区解释，不依赖数据库字符串比较
- **自校正机制**：每轮调度前会根据模板的 `schedule`、`last_spawned_at`、`created_at` 重新校正 `next_due_at`，降低历史脏值、时区切换、旧版本残留导致的提前调度风险
- **强制启动机制（已上线）**：定时实例 spawn 后会立即触发一次 `DriveOrchestrator.triggerTaskDrive()`；若实例在 `3` 分钟内仍无心跳，`CronExecutionMonitor` 会再补一次强制 drive；同一实例最多强制 `2` 次，若超过 `10` 分钟仍无心跳则自动升级给 `hermes-ops` 接管，避免静默卡死
- **尝试次数硬闸门（已上线）**：`DriveOrchestrator` 与强制 drive 入口会在执行前检查 `attempt_count >= max_attempts`；超上限任务会被立即纠正为 `blocked`，不再继续留在 `pending/in_progress`
- **实例 → 报告**：Hermes cron job 通过 `GET /todos/scheduled/pending` 查询待执行实例
- spawn 时自动创建 `task_notification`（assigned 类型），并记录系统已尝试立即驱动
- 手动触发模板实例化：`POST /todos/:id/spawn`
- **模板执行规范（推荐）**：在模板任务 description 中添加 `EXEC_SPEC`，让服务端可在驱动前做 Preflight（缺目录/缺脚本/缺命令/缺环境变量直接 blocked 并给出 blockers）
  - `CWD=/abs/path`
  - `SCRIPT=relative/or/abs/script.py`（可用逗号分隔多个）
  - `REQUIRES_BIN=python3,duckdb`（可选）
  - `REQUIRES_ENV=TUSHARE_TOKEN`（可选）
  - `REQUIRES_PATH=data/foo.duckdb`（可选，多项逗号分隔）

### 4.8 自动运维监控

| 监控模块 | 间隔 | 功能 |
|---------|------|------|
| StuckTaskMonitor | 3min | 基于动态阈值检测无心跳任务，自动恢复/标记 blocked（通知按类型冷却去重：recovered/blocked/zombie 60min，stalled 30min）。blocked 恢复前检查同模板是否已有活跃实例 |
| ZombieDetector | 10min | 检测无心跳 >2h 的 in_progress 任务标记为 blocked，防止弹跳循环 |
| DriveOrchestrator | 60s | 扫描所有有 focus 的任务，自动 drive + 验证，maxConcurrent=5。<br> **新增 Auto-Healing (自愈) 机制**：当任务遇到 Preflight 阻塞或长时间 stalled，Orchestrator 会自动调用 Consult 获取修复步骤（`fix_steps`），自动生成并派发高优子任务（`[修复] 自动修复任务`）。子任务完成后，父任务将自动被恢复为 `pending` 重新执行。 |
| ValidatorService | 随 Drive | 检测到 `pending_validation` 任务时自动调用 ValidationAgent 执行异步校验 |
| LLMInferencer | 5min | LLM 推断 idle 5-15 分钟的任务真实状态，高置信度自动标记 |
| WorkSnapshotMonitor | 2min | 采集所有 Agent 工作快照到 contexts（保留上限 30 条/会话） |
| GlobalCleanup | 6h | 清理过期 contexts（>7 天）、已读 notifications（>3 天），按 session 类型强制保留上限 |
| DailyScheduler | 60s | 检查到期的模板任务并生成实例，spawn 后立即尝试一次强制 drive |
| CronExecutionMonitor | 60s | 对 `3` 分钟无心跳的定时实例补一次强制 drive；超过 `10` 分钟仍无心跳则提醒、自动聚焦，并在强制次数耗尽后升级给 `hermes-ops` 接管 |
| AssignmentDriver | 60s | 自动聚焦已指派但未执行的任务 |
| CleanupMonitor | 24h | 归档超过 30 天的 completed/cancelled 任务 + 取消超 48h 过期 pending 任务 + 清理孤儿子任务（父任务已完成） |

---

## 五、部署与服务器环境

本服务支持从本地开发环境平滑迁移至服务器生产环境。在进行生产环境部署时，需遵循以下规范：

### 5.1 数据与环境隔离（强制规范）

为保障数据安全与环境独立，系统严格隔离开发与生产环境的数据：
- **开发环境**：默认数据库路径为 `data/todo.db`。
- **生产环境**：需通过设置环境变量 `DB_PATH` 指向独立的持久化目录（例如 `data/prod/todo.db`）。
- 服务已支持通过 `.env` 或 `.env.production` 动态加载配置。

### 5.2 生产环境安全配置

- **CORS 跨域限制**：在 `production` 模式下，需通过配置 `CORS_ORIGIN` 环境变量来限制 API 访问源，防止恶意跨域调用。
- **Agent 鉴权**：API 调用需校验 `X-Agent-Secret`，确保公网部署时该密钥的复杂度和保密性。

### 5.3 进程与日志管理

- 使用 `pm2` 运行生产实例。在 `ecosystem.config.js` 中已增加 `env_production` 配置节点。
- 启动生产环境命令：`pm2 start ecosystem.config.js --env production`。
- **结构化日志系统**：已全局引入 `pino` 替代 `console.log`。开发环境使用 `pino-pretty` 提供易读的彩色终端输出；生产环境默认输出 JSON 结构化日志。
- **日志轮转**：日志统一存放于 `logs/` 目录。生产环境建议通过内置脚本 `npm run pm2:install-logrotate` 一键安装并配置 `pm2-logrotate`，实现日志按 10M 切割、保留 7 天并自动压缩。

### 5.4 进阶安全与容器化部署（已实施）

为保障服务在公网生产环境的高可用与高安全性，系统已集成以下高级部署规范：

- **反向代理与 HTTPS (Nginx)**：
  - 已提供标准 Nginx 配置文件位于 `deploy/nginx/todo-server.conf`。
  - 支持将内部 Node.js 端口（3000）进行反向代理，并预置了强制 HTTPS 跳转和主流 SSL 安全配置。
- **API 限流（Rate Limiting）**：
  - 已在应用层（`src/server.js`）集成 `express-rate-limit` 中间件。
  - **生产环境 (`production`)**：限制单 IP 在 15 分钟内最多发起 1000 次请求，有效防止恶意刷量和服务雪崩。
  - **开发环境**：放宽至 15 分钟 10000 次，方便高频调试。
  - 当通过 Nginx 部署时，应用会自动信任代理层传递的真实 IP（`trust proxy`）。
- **容器化部署（Docker）**：
  - 项目根目录已提供生产就绪的 `Dockerfile` 与 `docker-compose.yml`。
  - 内部基于 `node:18-alpine`，自动安装依赖及 PM2。
  - 默认使用外部挂载卷映射 `data/prod` 和 `logs`，实现容器状态无状态化、数据持久化及快速一键部署（`docker-compose up -d`）。

---

## 六、API 速查

### 6.1 智能体

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agents` | 注册智能体 |
| GET | `/api/agents/:id` | 查询智能体 |
| DELETE | `/api/agents/:id` | 删除智能体 |

### 6.2 任务

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
| POST | `/api/agents/:id/todos/:id/request-help` | 智能体请求人工协助（留痕 + 通知） |
| POST | `/api/agents/:id/todos/:id/consult` | 疑难杂症咨询（LLM 诊断与修复建议） |
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

### 6.3 聚焦

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/agents/:id/focus` | 当前聚焦 |
| PUT | `/api/agents/:id/focus` | 手动设置聚焦 |
| POST | `/api/agents/:id/focus/auto` | 自动聚焦 |

### 6.4 项目

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agents/:id/projects` | 创建项目 |
| GET | `/api/agents/:id/projects` | 列出项目 |
| GET | `/api/agents/:id/projects/:id` | 获取项目 |
| GET | `/api/agents/:id/projects/:id/board` | 项目看板 |

### 6.5 通知

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/agents/:id/notifications` | 获取通知 |
| POST | `/api/agents/:id/notifications/:id/read` | 标记已读 |
| POST | `/api/agents/:id/notifications/read-all` | 全部已读 |

### 6.6 上下文

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
      "maxTokens": 2000
    },
    "openai": { "apiKey": "", "model": "gpt-3.5-turbo", "temperature": 0.7, "maxTokens": 2000 },
    "anthropic": { "apiKey": "", "model": "claude-3-5-haiku-20241022", "temperature": 0.7, "maxTokens": 2000 },
    "fallback": {
      "provider": "ollama",
      "baseUrl": "http://localhost:11434/v1",
      "model": "Qwen3.5_9b_f16:latest",
      "temperature": 0.7,
      "maxTokens": 2000
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
- `maxTokens`：Provider 默认建议控制在 `1024-2000`，具体链路按场景做 per-call 覆盖；不要再全局放大 token 上限
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
│  │        Agent Loop（最多 4 轮）        │    │
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
| **循环次数上限** | Agent Loop 最多 4 轮（`MAX_ITERATIONS=4`） |
| **响应截断** | 工具返回结果超过 1000 字符时自动截断（`MAX_OUTPUT_LENGTH=1000`） |
| **收敛强制** | 第 2 轮开始强提醒收敛，第 3 轮为最后工具轮，第 4 轮强制输出 JSON 判定 |
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
| 6 | Validation / Consult / Focus / TemplateNormalization | 增加分链路 token 预算与降级护栏 | ✅ 已完成 |
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
| 命令失败结构化留痕 + 自动阻塞 | `src/services/DriveOrchestrator.js` | 命令执行结果写回 attempt_log；检测到缺少目录/脚本/命令等环境问题时直接标记 blocked 并写入 blockers |
| 支持 validation_failed 重试 | `src/services/DriveOrchestrator.js` | 自动重试并携带校验反馈给 LLM |
| 100%进度自动触发验证 | `src/services/DriveOrchestrator.js` | 进度达到100%时自动转为 pending_validation |
| 验证反馈传递给重试 | `src/services/DriveOrchestrator.js` | buildRetryContext 包含验证失败反馈 |
| 第三方验证机制 | `src/services/ValidationDispatchService.js` | 派发独立验证任务给第三方 Agent |
| 疑难杂症咨询接口 | `src/routes/todos.js` | 增加 /consult：基于任务执行记录生成排障结论、修复步骤与 preflight 清单 |
| 自动触发排障咨询（blocked/stalled） | `src/services/DriveOrchestrator.js` | 当任务因环境缺失被阻塞或多轮无进展时，自动调用 LLM 生成排障建议并写入 contexts/notifications |

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
| Agent Loop（验证） | ✅ | - | - | - | ValidationAgent 4 轮轻量工具调用 + RESULT-FIRST + 系统日志过滤 + 强制判定兜底 |
| StructuredDriveTools | ✅ | - | - | - | executeCommand/readFile/checkPath/updateProgress/proposeCompletion/confirmCompletion/askForHelp；已接入 DriveOrchestrator 工具优先主循环，保留 legacy fallback |
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
- [x] 规则优先任务状态分析（focus 默认关闭实时 LLM 推断）
- [x] CleanupMonitor 自动归档超过 30 天的任务
- [x] Python CLI Skill（`propose-completion`）
- [x] Profile 感知自动匹配凭证
- [x] Skill 同步到所有 Hermes profile
- [x] **ValidationAgent（LLM Agent Loop + 5 个工具）** — 轻量多轮工具调用独立验证
- [x] **所有 Provider tools 支持** — MiniMax/OpenAI/Ollama/Anthropic 全部支持 tools
- [x] **LLMManager 参数透传修复** — maxTokens/temperature 正确传递到 Provider
- [x] **链路级 token 预算治理** — Validation / Consult / Focus / TemplateNormalization 按场景单独限额，避免全局放大
- [x] **收敛规则 + 快速路径 + 系统提醒** — 防止 ValidationAgent 无限循环
- [x] **StructuredDriveTools** — executeCommand/readFile/checkPath/updateProgress/proposeCompletion/confirmCompletion/askForHelp
- [x] **DriveOrchestrator 工具优先执行闭环（阶段一）** — 已实现工具优先 Agent Loop、即时结果回灌、fallback 原因统计、token 预算退出留痕与关键降级路径测试
- [x] **LLM Provider 热插拔** — 运行时切换 Provider（API + Framework），无需重启

### 11.2 待实现

| 优先级 | 功能 | 预估工作量 | 收益 |
|--------|------|-----------|------|
| ~~P0~~ | ~~**内嵌验证智能体（ValidationAgent）**~~ | ~~2-3 天~~ | ~~高~~ |
| ~~P0~~ | ~~LLM Provider tools 支持（MiniMax/OpenAI）~~ | ~~0.5 天~~ | ~~高~~ |
| P0 | 后端禁止修改 Agent 任务状态 | 0.5 天 | 高（安全性） |
| ~~P0~~ | ~~DriveOrchestrator ReAct Agent Loop 收尾（覆盖率提升 + token 预算 + 缩减 legacy fallback）~~ | ~~1-2 天~~ | ~~高（任务完成率）~~ |
| P1 | WebSocket 实时推送 | 1-2 天 | 中（体验提升） |
| P1 | 可视化管理界面完善 | 2-3 天 | 高（运维友好） |
| P1 | 任务优先级管理机制 | 1-2 天 | 高（防止验证任务被抢占） |
| P1 | Tool Loop 覆盖率提升与全局 token 用量聚合 | 1-2 天 | 中（成本控制+持续优化） |
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

> 最后更新：2026-05-07 - 新增四批稳定性治理，并完成第五批 token 降耗护栏（Validation/Consult/Focus/TemplateNormalization）

---

## 十五、改进建议

### 15.1 P0 紧急（影响正确性/安全性）

1. **认证中间件 timing-safe 比较**：当前 `===` 比较 secret_key 存在 timing attack 风险
2. **MemoryManager 内存存储脆弱性**：依赖 `localStorage`（Node.js 不存在），重启即丢失
3. **输入验证缺失**：路由层缺乏系统性输入校验
4. **DriveOrchestrator 实时多步推理已完成阶段一落地**：当前已具备工具优先 Agent Loop、命令结果即时回灌、fallback 原因统计、token 预算退出留痕，以及成功/求助/降级路径测试。后续重点转为提升工具覆盖率并逐步缩减 legacy fallback 占比。

### 15.2 P1 高优先级（影响性能/可维护性）

5. **Framework.js 单体职责过重**：~800行承担多个职责
6. **ConfigLoader 脆弱的配置搜索**：依赖 `require.main.filename`
7. **缺少速率限制**：所有 API 无速率限制
8. **缺少全局 Token 用量聚合**：DriveOrchestrator 的 tool loop 已具备局部 token 预算与超预算退出留痕，但系统级 usage 聚合、跨模块预算视图仍未建立
9. **9 个定时器硬编码在 server.js**：全部 `setInterval`，无统一调度器，单进程重复执行风险
10. **命令提取依赖正则**：`CommandExecutor` 用 `BLOCK_REGEX`/`LINE_CMD_REGEX` 提取命令，脆弱且需要维护 80+ 个 `INVALID_PREFIXES` 黑名单

### 15.3 P2 中优先级（影响质量/工程规范）

11. **数据库迁移策略需优化**：逐个 try/catch ALTER TABLE 无法回滚
12. **缺乏 API 文档**：仅有路由列表，无请求/响应示例
13. **错误处理不一致**：混用多种错误处理方式
14. **测试覆盖率待提升**：Express 路由层、SDK 等未覆盖
15. **Agent 间无消息传递通道**：只有任务指派和通知，缺乏双向对话能力
16. **所有 Agent 共享 LLM 配置**：无法为不同 Agent 配置不同模型或参数
17. **StructuredDriveTools 已接入 DriveOrchestrator 主循环并完成阶段一闭环**：目前默认优先走结构化 tool loop，执行失败或无 tool call 时回退 legacy 命令提取链；后续工作以提升 executeCommand 覆盖率、收缩 legacy fallback、建设全局统计视图为主。
18. **尝试次数状态机已补硬闸门**：自动 drive/强制 drive 在真正执行前会校验 `attempt_count`，超上限任务会被自动收敛到 `blocked`，避免出现“尝试次数已耗尽却仍停留在 in_progress”的状态污染。

### 15.4 V1.2 架构演进路线（Agent Loop 核心能力提升）

#### 15.4.1 A 组：Agent Loop 核心能力增强

**A1. DriveOrchestrator ReAct Agent Loop 升级**（已完成阶段一）

legacy 路径当前问题：
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

阶段一已完成改动：
- `DriveOrchestrator.driveTask()` 已引入工具优先 Agent Loop，每轮工具结果会回灌到后续推理
- `StructuredDriveTools` 已扩展执行型工具：`executeCommand`、`readFile`、`checkPath`、`updateProgress`、`proposeCompletion`、`askForHelp`
- 已保留 legacy 命令提取链作为 fallback，并记录 fallback 原因与退出留痕
- 已补成功路径、`askForHelp` 路径、token 超预算回退路径测试

**A2. ValidationAgent 增强自我反思**

- 添加 `reflect` 工具让 LLM 每 3 轮自我评估"证据是否足够"
- 添加证据置信度评分，低置信度触发额外验证

**A3. Token 预算控制**

- `DriveOrchestrator` 的 tool loop 已设置局部 token 预算上限并在超预算时留下结构化退出记录
- 后续可在 `LLMManager` 增加全局 `usageTracker`，聚合各 Agent Loop 的 token 消耗
- 长期目标是建立跨 drive/validation 的统一预算与成本面板

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

### 15.6 当前阶段主线判断（2026-05）

从项目定位看，当前产品已经不是单纯的 TODO CRUD 服务，而是一个面向多智能体协作的**任务编排 + 自驱执行 + 自动验收平台**。因此，当前最应优先优化的方向不是继续扩展界面层或新增外围功能，而是先补齐最核心的执行闭环能力。

**当前最高优先级结论：**

- **第一优先级：执行内核升级** —— 以 `DriveOrchestrator` 为核心，将自动驱动链路从“文本回复 + 正则命令提取”升级为“LLM + 工具调用 + 多轮反馈”的 ReAct Agent Loop
- **第二优先级：调度与执行中台收敛** —— 将 `server.js` 中分散的定时任务抽离为统一调度器，降低耦合和竞态
- **第三优先级：安全、测试与文档补强** —— 在执行主链稳定后补齐认证、安全、持久化、测试与对外文档

判断依据：

1. 项目核心卖点在“任务能被稳定做完并自动验收”，而不是“任务能被创建和展示”
2. `ValidationAgent` 已经具备工具化闭环雏形，但 `DriveOrchestrator` 仍主要依赖文本约定和命令提取，执行端成熟度低于验收端
3. `StructuredDriveTools` 已扩展为 `executeCommand` / `readFile` / `checkPath` / `updateProgress` / `proposeCompletion` / `askForHelp` 等结构化接口，并已成为 `DriveOrchestrator` 的默认优先路径；当前剩余工作是提高工具覆盖率并逐步缩减 legacy fallback
4. 若先投入 Web UI、WebSocket、监控面板等外围功能，只会放大底层执行链不稳定带来的问题

### 15.7 三阶段实施方案（建议执行版本）

#### 阶段一：执行内核升级（最高优先级）

**目标：** 把 `DriveOrchestrator` 升级为真正的 ReAct/Tool-Driven 执行闭环，让“被分派的任务能稳定推进并进入验收”成为系统第一能力。

**当前阶段定位补充：**

- `任务看板` 仍然是产品对外的主形态，用于任务展示、人工介入、异常追踪和跨 Agent 协作
- 但本阶段的主攻方向不是继续扩展泛化待办能力，而是把系统收束为**定时作业运行管理工具**
- 当前所有改造都应优先服务于一件事：**提升服务内已注册定时任务的启动率、完成率、验收通过率和异常可解释性**

**建议周期：** 3-5 天

**阶段一重点要解决的问题：**

- **问题 1：到点生成了实例，但不一定真正被拉起执行**
  - 典型表现：模板任务 `spawn` 后停在 `pending` 或刚切到 `in_progress`，长时间没有首个有效心跳
  - 对作业的影响：任务看板里“看起来有任务”，但作业实际上没有开跑，导致错过时间窗口
- **问题 2：执行链过度依赖自由文本和命令提取，任务推进不稳定**
  - 典型表现：LLM 回了一段文字，但没有形成有效动作；命令执行结果没有进入下一轮推理；进度更新依赖固定文本格式
  - 对作业的影响：同类定时任务在不同轮次表现波动大，完成率不稳定，失败原因不容易复盘
- **问题 3：异常恢复与重试链条缺少硬约束，容易出现状态污染**
  - 典型表现：任务在 `pending / in_progress / blocked` 之间反复拉扯，甚至出现 `attempt_count >= max_attempts` 仍继续自动 drive
  - 对作业的影响：队列里会出现“假启动”“恢复循环”“超上限仍在跑”等噪声，影响运营判断
- **问题 4：定时作业执行结果缺少统一的结构化闭环**
  - 典型表现：作业完成、求助、阻塞、进入验收的留痕方式不统一
  - 对作业的影响：很难稳定统计“今天多少作业真正开跑了、多少作业真正完成了、多少作业是靠人工兜底”

**阶段一对应解决手段：**

- **针对问题 1：补“强制启动链”**
  - `DailyScheduler` 在模板实例生成后立即触发一次 `DriveOrchestrator.triggerTaskDrive()`
  - `CronExecutionMonitor` 对 `3` 分钟无心跳实例补一次强制 drive
  - 强制次数耗尽且超过 `10` 分钟仍无心跳时，自动升级给 `hermes-ops` 接管
- **针对问题 2：补“工具优先执行闭环”**
  - `DriveOrchestrator.driveTask()` 从文本驱动改成多轮工具调用循环
  - 以 `StructuredDriveTools` 为默认执行协议，优先走 `executeCommand / readFile / checkPath / updateProgress / proposeCompletion / askForHelp`
  - 工具结果即时回灌下一轮推理，而不是只在失败后通过文本重试兜底
- **针对问题 3：补“状态机硬闸门”**
  - 在自动 drive 和强制 drive 入口统一检查 `attempt_count >= max_attempts`
  - 超上限任务立即收敛为 `blocked`，不再继续停留在 `pending / in_progress`
  - 对 fallback、超预算、无进展、强制 drive、升级接管都写结构化 context 留痕
- **针对问题 4：补“作业级可追踪结果链”**
  - 完成通过 `proposeCompletion()` 统一进入 `pending_validation`
  - 阻塞通过 `askForHelp()` 或结构化 blocker 写入
  - 调度、强制启动、升级接管、重试耗尽都落在统一上下文链里，便于统计和追溯

**核心改造：**

- 重写 `DriveOrchestrator.driveTask()` 为多轮执行循环：
  - 读取任务当前状态
  - 调用 LLM 决定下一步动作
  - 执行工具
  - 将工具结果即时反馈给下一轮推理
  - 判断完成 / 阻塞 / 请求协助 / 提交验收
- 以 `StructuredDriveTools` 为默认执行协议，优先使用：
  - `updateProgress`
  - `proposeCompletion`
  - `confirmCompletion`
  - `askForHelp`
- 增加执行期工具集，建议至少包括：
  - `execute_command`
  - `read_file`
  - `check_path`
  - `update_progress`
  - `propose_completion`
  - `ask_for_help`
- 保留现有 `CommandExecutor` 正则提取链作为 fallback，第一版不要直接删除旧逻辑
- 给执行循环增加收敛控制：
  - 最大轮数
  - 最大 token 预算
  - 连续无进展检测
  - 重复空调用检测

**阶段一验收标准：**

- 自动驱动不再依赖自由文本中的 “进度: XX% / 步骤:” 格式
- 命令执行结果能够进入同一轮任务的后续推理，而不是仅在 retry 时通过 `retryContext` 间接传递
- 常见任务默认走结构化工具更新进度和提交流程
- 任务满足完成条件后优先进入 `pending_validation`
- 阻塞项、求助请求、完成提案均有结构化留痕

**阶段一最终应体现在作业上的结果：**

- **启动层面**
  - 定时作业在到点后不再只是“生成实例”，而是应当尽快出现首个有效执行动作
  - 看板上能明确区分：`已生成但未启动`、`已强制启动`、`已升级接管`
- **执行层面**
  - 同类已注册作业的执行方式更稳定，不再高度依赖某次 LLM 回复质量
  - 作业从 `pending -> in_progress -> pending_validation / blocked` 的迁移更可预测
- **质量层面**
  - 作业完成不再只看“Agent 说做完了”，而是更多通过工具调用、产出物检查和结构化提交流程进入验收
  - 失败或卡住时，能明确知道是“没启动”“没进展”“超预算”“环境阻塞”还是“尝试次数耗尽”
- **运营层面**
  - 可以围绕已注册定时作业稳定统计：
    - 到点启动率
    - 首心跳达成率
    - 最终完成率
    - 自动恢复成功率
    - 升级给 `hermes-ops` 的比例
  - 这会让任务看板从“任务列表”变成“作业运行驾驶舱”

**建议补充的作业运营指标口径：**

- **计划作业数**
  - 定义：指定时间窗口内，模板按 `schedule` 理应生成的作业实例总数
  - 用途：作为后续所有启动率、完成率指标的分母
- **已生成实例数**
  - 定义：实际由 `DailyScheduler` 生成的模板实例数量
  - 用途：观察模板计划与调度引擎是否一致，识别漏调度
- **到点启动率**
  - 定义：`已在阈值内进入 in_progress 的实例数 / 已生成实例数`
  - 建议阈值：`3 分钟`
  - 用途：衡量“生成后能否及时被拉起”
- **首心跳达成率**
  - 定义：`在阈值内写入首个有效 last_heartbeat 的实例数 / 已生成实例数`
  - 建议阈值：`5 分钟`
  - 用途：区分“假启动”和“真正开始执行”
- **最终完成率**
  - 定义：`进入 completed 的实例数 / 已生成实例数`
  - 用途：衡量作业真正闭环能力
- **自动恢复成功率**
  - 定义：触发过自动恢复的实例中，最终完成的比例
  - 用途：判断 `StuckTaskMonitor` / 强制 drive / 升级接管是否真的有效
- **升级接管率**
  - 定义：`被升级给 hermes-ops 的实例数 / 已生成实例数`
  - 用途：衡量系统自主完成不足的程度
- **阻塞率**
  - 定义：`最终进入 blocked 的实例数 / 已生成实例数`
  - 用途：衡量环境问题、脚本问题、依赖缺失等真实阻塞程度

**建议的看板字段设计：**

- **总览卡片**
  - `今日计划作业数`
  - `今日已生成实例数`
  - `今日完成数`
  - `今日 blocked 数`
  - `今日升级给 hermes-ops 数`
- **核心比率卡片**
  - `到点启动率`
  - `首心跳达成率`
  - `最终完成率`
  - `自动恢复成功率`
  - `升级接管率`
- **作业队列表**
  - `作业标题`
  - `模板 ID / 实例 ID`
  - `所属 agent`
  - `计划触发时间`
  - `实例生成时间`
  - `首次进入 in_progress 时间`
  - `首个 last_heartbeat 时间`
  - `当前状态`
  - `当前进度`
  - `当前步骤`
  - `attempt_count / max_attempts`
  - `是否被强制启动`
  - `是否已升级给 hermes-ops`
- **异常聚焦区**
  - `超过 3 分钟未启动`
  - `超过 5 分钟无首心跳`
  - `自动恢复次数 >= 2`
  - `尝试次数已耗尽`
  - `已升级给 hermes-ops 仍未完成`

**指标落地建议：**

- 第一版可以先基于现有 `todos`、`contexts`、`task_notifications` 计算，不必立刻新建统计表
- 等口径稳定后，再补 `job_runs` / `scheduler_events` 这类独立事件表，降低统计查询复杂度
- 看板第一版先做“只读运营视图”，不要一开始就混入太多交互操作，先把口径跑稳

**模板标准化与强制规范化：**

- 当前系统已不再把“模板规范”仅作为人工约定，而是在任务创建与更新入口增加了**系统强制规范化**
- 规范化适用范围：
  - `POST /todos`
  - `PUT /todos/:id`
  - `POST /todos/:id/sub-tasks`
  - 以及所有直接调用 `Todo.create()` / `Todo.update()` 的内部链路
- 系统会自动完成的规范化动作：
  - 自动去除 `title`、`description`、`schedule`、`assignedAgentId`、`acceptanceCriteria` 两端空白
  - 如果传入 `schedule`，则强制将任务识别为模板任务
  - 模板未提供默认执行者时，自动回填为当前 `agentId`
  - 模板未提供 `acceptance_criteria` 时，自动生成默认验收标准
  - 模板未提供 `description` 时，自动补齐模板用途说明
  - 非法 `priority` 会回落为 `medium`
  - 非法 `max_attempts` 会回落为 `3`
  - 非数组的 `tags` / `dependencies` 会被规范化为数组
  - `task_category` 会根据标题和描述自动推断
- 系统不会自动猜测的字段：
  - `schedule` 的业务含义不会被系统臆造；如果模板任务没有有效 `schedule`，会直接拒绝
  - 依赖项若引用不存在任务，仍然会被接口拒绝，不会静默吞掉
- 返回结果中会附带 `normalization` 字段，用于标记本次是否发生自动规范化，便于智能体和人工调用方及时纠偏
- 这项机制的目标不是“让脏数据也能混进去”，而是把**可自动修复的输入偏差**当场收敛，把**无法自动推断的关键缺口**直接挡在入口外

**模板最低可用标准：**

- 一个可用于定时作业运营的最小合格模板，至少应具备：
  - `schedule`
  - `assigned_agent_id`
  - `task_category`
  - `description`
  - `acceptance_criteria`
  - `max_attempts`
- 其中 `assigned_agent_id`、`description`、`acceptance_criteria`、`task_category` 现已支持系统自动补齐
- `schedule` 仍然必须由调用方明确提供，因为它代表的是业务调度意图，不能由系统主观猜测

**不合格模板的 Agent2Agent 治理修正：**

- 对于历史遗留的“不合格模板”，系统已新增 `TemplateNormalizationService`
- 修正入口：
  - `POST /api/agents/:agentId/todos/templates/normalize-noncompliant`
- 工作方式：
  - 先扫描当前 agent 下不合格模板
  - 由模板所属 agent 向 `template governor agent` 发起结构化治理请求
  - 治理 agent 基于模板标题、描述、上下文和缺口字段，生成**白名单补丁建议**
  - 系统只允许对白名单字段落库：
    - `schedule`
    - `assignedAgentId`
    - `taskCategory`
    - `description`
    - `acceptanceCriteria`
    - `maxAttempts`
  - 落库后再次按最低可用标准复核是否已达标
- 审计要求：
  - 治理请求与治理回复会同时记录到 `owner agent` 和 `governor agent` 的 `contexts`
  - 结果会写入模板任务通知，便于后续追踪
- 风险控制：
  - LLM 不能直接写数据库，只能输出建议 JSON
  - `schedule` 只有在标题/描述中已有明显时间/频率信息时才允许补齐
  - 无法安全推断的模板会保留为“仍需人工确认”，不会被系统强行臆造
- 目标：
  - 把历史脏模板治理从“人工逐条排查”升级为“系统批量扫描 + Agent2Agent 对话补齐 + 人工只处理剩余难例”
- 当前开发库治理结果（2026-05-07）：
  - 最低可用标准化模板已达到 `21/21`
  - 最后一批人工确认并落库的调度规则为：
    - `每周概念股数据同步（concept）` -> `0 18 * * 2`
    - `每日沪深港通数据增量同步（hsgt）` -> `25 17 * * 1-5`
    - `每日涨跌停数据增量同步（stk_limit）` -> `30 17 * * 1-5`
  - 当前开发库已无剩余最低可用口径下的不合格模板

**稳定达到 90%+ 的优化路径：**

- 现阶段要把作业完成率稳定到 `90%+`，不能只靠补模板和补强制启动，还必须把系统从“能跑起来”推进到“可预测闭环”
- 目标口径建议明确为：
  - `最终完成率 = completed / 已生成实例数`
  - `校验通过率 = validation_passed / 进入验收实例数`
  - 统计范围以**已标准化注册模板**生成的作业实例为准
- 当前 `21/21` 模板标准化已经解决了“输入质量不稳定”的问题，但距离稳定 `90%+` 还差四个层面：
  - `到点未真正启动`
  - `启动后缺少首心跳或很快卡住`
  - `执行链对单次 LLM 回复仍然较敏感`
  - `完成后证据不足，导致验收波动`

**P0：先把启动率稳定到 95%+**

- 对所有模板实例强制记录：
  - `scheduled_at`
  - `spawned_at`
  - `first_in_progress_at`
  - `first_heartbeat_at`
- 以 `3 分钟` 为启动 SLA、`5 分钟` 为首心跳 SLA，超时立即进入恢复链，而不是继续等待自然推进
- 现有强制 drive 机制保留，但要补一层“启动结果分类”：
  - `未抢到执行权`
  - `LLM 无响应`
  - `工具调用失败`
  - `环境依赖缺失`
  - `已升级接管`
- 对高频模板按时间带拆开，避免 `17:00-17:30` 内过度并发挤压同一 agent
- 对 `hermes-default` 增加模板级并发预算与限流，不允许同一分钟拉起过多重型数据同步任务

**P1：把执行链从“可尝试”改成“可复现”**

- 对每类模板补“执行画像”，至少包括：
  - `executor_type`
  - `entry_command`
  - `expected_outputs`
  - `success_criteria`
  - `validation_type`
- 对脚本类模板，执行前先跑统一 preflight：
  - 脚本是否存在
  - 目标库路径是否存在
  - 关键依赖是否可导入
  - 上次实例是否仍在运行
- `DriveOrchestrator` 里现有 `toolLoopMaxIterations=6`、`toolLoopTokenBudget=50000`、`maxNoProgressRounds=2` 更适合兜底，不适合作为高完成率主路径
- 真正冲 `90%+` 时，主路径应该优先走“结构化执行协议”：
  - 先明确执行计划
  - 再执行命令
  - 再采集结果
  - 再结构化提交完成
- 对重复失败的模板，增加“模板级熔断”：
  - 当同模板连续 `N` 次失败时，暂停继续自动生成，并推送治理告警

**P2：把验收通过率稳定到 90%+**

- 完成不等于通过，必须把“完成证据”收成统一结构：
  - 执行命令摘要
  - 产出文件/表
  - 核心结果计数
  - 关键时间点
  - 异常说明
- 验证端不再只看自然语言总结，要按模板类型走固定 validator：
  - `script`：检查脚本退出、目标表最新日期、核心行数/字段
  - `inspection`：检查巡检结论、异常项、是否允许继续运行
  - `backup`：检查备份文件存在、大小、抽样恢复可读
- 对抽检场景，必须保留“执行证据 + 验证证据”双链路，保证人工抽检时能复盘
- 对 `pending_validation` 超时任务，不能长期堆积，应在到达阈值后自动升级给验证 agent 或运营 agent

**P3：把 90% 做成可持续指标，而不是一次性冲高**

- 增加 `job_runs` / `scheduler_events` 两张事件表，避免后续所有运营指标都从 `todos` 反推
- 每次作业实例至少记录：
  - `template_id`
  - `run_id`
  - `planned_at`
  - `spawned_at`
  - `started_at`
  - `first_heartbeat_at`
  - `completed_at`
  - `validated_at`
  - `final_status`
  - `failure_bucket`
- `failure_bucket` 必须标准化，建议固定为：
  - `not_started`
  - `no_heartbeat`
  - `tool_failure`
  - `env_missing`
  - `llm_unstable`
  - `validation_failed`
  - `human_blocked`
- 只有把失败归因固定下来，后面才可能针对性把 `90%+` 稳住，而不是每周重复排查同类问题

**建议的实施优先级：**

- **第 1 步：补事件字段和失败分桶**
  - 目标：先把“为什么没到 90%”量化出来
- **第 2 步：补模板级 preflight + 熔断**
  - 目标：把明显会失败的实例挡在执行前
- **第 3 步：补固定 validator 与证据结构**
  - 目标：把校验通过率稳定到 `90%+`
- **第 4 步：按时间带和 agent 容量重排调度**
  - 目标：把集中拥塞导致的启动/心跳问题压下去

**阶段性验收标准：**

- `到点启动率 >= 95%`
- `首心跳达成率 >= 93%`
- `最终完成率 >= 90%`
- `校验通过率 >= 90%`
- `pending_validation` 超时堆积数接近 `0`
- 任一模板连续失败达到阈值时，系统能自动熔断并告警，而不是持续产出坏实例

**当前已落地的第一批治理（2026-05-07）：**

- 已默认关闭高频低价值的 `LLMInferencer`，不再用 LLM 猜测 `idle 5-15 分钟` 任务状态，避免持续消耗 MiniMax 配额
- 已移除 `ContextManager` 和 `FocusState` 中的 LLM 排序/选任务分支，聚焦逻辑回退为规则优先
- 已新增 `job_runs` / `scheduler_events` 事件层，开始记录作业实例的 `planned_at / spawned_at / started_at / first_heartbeat_at / pending_validation_at / completed_at / validated_at / final_status / failure_bucket`
- 已新增标准化 `failure_bucket`：
  - `not_started`
  - `no_heartbeat`
  - `tool_failure`
  - `env_missing`
  - `llm_unstable`
  - `validation_failed`
  - `human_blocked`
- 已把 `DailyScheduler`、`CronExecutionMonitor`、`DriveOrchestrator`、`StructuredDriveTools`、`Todo` 状态更新链接入事件层，为后续完成率/验证通过率看板打底

**当前已落地的第二批治理（2026-05-07）：**

- 已新增 `TemplatePreflightService`，在 `DailyScheduler` 生成实例前先做模板级预检
- 模板描述中若声明了显式 preflight 规范，例如：
  - `CWD=...`
  - `SCRIPT=...`
  - `REQUIRES_BIN=...`
  - `REQUIRES_ENV=...`
  - `REQUIRES_PATH=...`
  调度前会先检查目录、脚本、命令、环境变量、关键路径是否存在
- 若模板预检失败，调度器不会继续 spawn 新实例，而是记录 `template_preflight_blocked` 事件并保留审计上下文
- 已新增模板级连续失败熔断：
  - 默认阈值：连续失败 `3` 次
  - 默认冷却：`120` 分钟
  - 连续失败达到阈值后，模板进入 `circuit_open_until`
  - 冷却结束后允许再次尝试一次，而不是因为旧失败记录立即再次熔断
- 这批改造的目的不是“让所有模板都继续跑”，而是把明显会失败的模板挡在实例生成之前，减少无效实例、空转驱动和配额浪费

**当前已落地的第三批治理（2026-05-07）：**

- 已新增 `ValidationPolicyService`，把验证链改成“固定策略优先，LLM/ValidationAgent 兜底”
- 当前优先支持的固定策略包括：
  - `inspection`
  - `script`
  - `backup`
  - `code_change`
  - `generic`
- `proposeCompletion` 现在会把结构化证据写入 `completion_report.validationEvidence`，至少包括：
  - `criteriaMet`
  - `artifacts`
  - `evidenceLines`
  - `summary`
- `ValidatorService` 会先读取 `completion_report` 和 `validationEvidence`，若证据足够则直接完成自动验收，不再优先消耗 LLM
- 若结构化证据不足，系统不会轻易放过，而是进入规则拒绝或再回退到 `ValidationAgent`
- 已新增 `pending_validation` 超时升级：
  - 若待验收任务长时间未被处理，`StuckTaskMonitor` 会主动触发验证
  - 若启用了第三方验证，则升级派发验证任务
  - 否则立即触发内嵌自动验收，而不是让任务长期堆在 `pending_validation`
- 这批改造的目标是把“做完了但验不过 / 没人验 / 等太久”这三类问题从系统层压下去，直接服务于 `90%+` 的验证通过率目标

**当前已落地的第四批治理（2026-05-07）：**

- 已新增 `ScheduleGovernanceService`，在 `DailyScheduler` 生成实例前补上调度治理闸门
- 当前默认治理策略：
  - 同模板只允许 `1` 个活跃实例
  - 每个 agent 在短时间窗口内最多生成 `2` 个定时实例
  - `inspection / backup` 类模板会进一步收紧 burst，避免占满调度窗口
- 模板描述中支持显式覆盖治理参数：
  - `MAX_ACTIVE_INSTANCES=<n>`
  - `SCHEDULE_BURST_LIMIT=<n>`
  - `SCHEDULE_BURST_WINDOW_MINUTES=<n>`
- 已新增 `task_spawn_skipped` 事件，调度器跳过模板时会写清楚具体原因，例如：
  - `template_active_limit`
  - `agent_capacity_reached`
  - `agent_spawn_burst_limit`
- 已新增 `OpsMetricsService`，基于 `job_runs / scheduler_events` 输出运营指标
- 当前可直接读取的关键指标包括：
  - `spawned_jobs`
  - `started_jobs`
  - `first_heartbeat_jobs`
  - `completed_jobs`
  - `entered_validation_jobs`
  - `validation_passed_jobs`
  - `blocked_jobs`
  - `startup_rate`
  - `first_heartbeat_rate`
  - `completion_rate`
  - `validation_pass_rate`
  - `blocked_rate`
- 已新增接口：
  - `GET /api/agents/:agentId/todos/stats/ops?hours=24`
- 这批改造的目标是把“系统已经更稳”进一步变成“系统能持续量化观察、持续调参优化”，为后续把完成率和验证通过率稳定到 `90%+` 提供运营抓手

**当前已落地的第五批治理（2026-05-07）：**

- 已把 `ValidationAgent` 的默认验证预算从“高轮数 + 超大 token”收紧为：
  - 最多 `4` 轮
  - 每轮最多 `2` 个工具调用
  - 单次 `maxTokens=3000`
- 已把 `DriveOrchestrator` 结构化工具主循环收紧为：
  - 最多 `4` 轮
  - 总预算 `12000 token`
  - 单轮最多 `3000 token`
- 已把 `focus` 路由中的实时 LLM 工作状态分析默认关闭，改为规则引擎优先，只有显式开启 `ENABLE_FOCUS_LLM_ANALYSIS=1` 才会恢复
- 已把 `/api/agents/:agentId/todos/:id/consult` 与 `DriveOrchestrator.consultTask()` 改为压缩摘要 prompt：
  - 不再直接拼接完整 `report.execution` JSON
  - 仅保留最近尝试、执行统计、验证摘要、短时间线
  - 单次 `maxTokens=1200`
- 已把 `env_missing / preflight_blocked` 类自动排障改成规则引擎优先：
  - 目录不存在、环境变量缺失、脚本/命令缺失、权限不足等问题直接生成确定性修复步骤
  - 不再为这类高频确定性阻塞默认触发模型请求
- 已把 `TemplateNormalizationService` 的模板治理对话改为截断长字段并限制 `maxTokens=1200`
- 已把模板规范化改成规则优先：
  - `assigned_agent_id / task_category / max_attempts / 明确可推断的 schedule` 优先由规则补齐
  - 只有涉及描述、验收标准等语义补全时才进入 agent2agent / LLM
- 已新增 `tests/token-guards.test.js`，回归锁定：
  - 验证链预算上限
  - 排障咨询 prompt 压缩
  - 模板治理 prompt 限额
  - 确定性缺口跳过模型请求
- 这批改造的目标不是“完全不用 LLM”，而是把 LLM 收敛到真正高价值、低频、可解释的环节，避免 TODO Server 再出现高频低价值调用把额度打爆

**当前开发库 24h 基线（2026-05-07 实测）：**

- 基线拉取方式：执行 `node scripts/query_ops_baseline.js`
- 由于历史 `job_runs` 尚未持续沉淀，脚本会先对当前开发库活跃任务执行一次 `OpsBackfillService.backfillActiveRuns({ hours: 24 })`，把当天活跃实例回填进运行统计，再输出 `stats/ops` 口径结果
- 本次回填结果：
  - `scannedTasks=76`
  - `runsCreated=13`（在前一次回填基础上继续补齐新归因实例）
  - `bucketsAssigned=13`
- 本次 24h 指标基线：
  - `spawned_jobs=89`
  - `startup_rate=86.52%`
  - `first_heartbeat_rate=57.30%`
  - `completion_rate=49.44%`
  - `validation_pass_rate=0%`（当前开发库这批样本尚未形成有效 validated pass 事件）
- 当前 24h 最大拖累项（按 `failure_buckets`）：
  - `no_heartbeat=25`
  - `not_started=6`
- 对应定点治理已落地：
  - `no_heartbeat`：`StuckTaskMonitor` / `ZombieDetector` 在自动恢复、阻塞标记时会同步写入 `failure_bucket=no_heartbeat`
  - `not_started`：`AssignmentDriver` 对超时未启动的已指派任务同步写入 `failure_bucket=not_started`，并尝试自动驱动
  - `stats/ops` 可观测性：新增 `OpsBackfillService`，定期把当前活跃任务补录到 `job_runs`，避免看板长期只显示空白或 `none`

**今日状态收口与页面口径修正（2026-05-07）：**

- 已确认后台页面“default 几千个任务”属于统计口径问题，不是今天真的新增了几千个活跃任务
- 根因：
  - `/api/agents/:agentId/todos/stats` 旧逻辑把 `archived=1` 的历史任务也算进了 `total / active_tasks`
  - `public/index.html` 概览页优先展示了 `active_tasks`，导致页面把沉积历史一起显示为“总任务”
- 已修复代码：
  - `Todo.getStats()` 只统计未归档任务
  - `active_tasks` 改为真正的非终态活跃任务
  - 前端“总任务”改为优先展示 `total`
- 已完成服务重启与页面口径切换：
  - 本地 `todo-server` 已重启到最新代码
  - 网页端现在展示的是最新统计口径，不再把 `archived` 历史任务混进“总任务/活跃任务”
- 今日已统一收口的脏状态：
  - 自动取消了 `6` 个“父任务已 completed/cancelled，但修复子任务仍挂着”的自动修复子任务
  - 人工确认完成并收口了 `3` 个实际上已完成但仍卡在 `in_progress` 的巡检类任务：
    - `schedule_test_daily`
    - `【巡检】每日深度巡检`
    - `🟡 数据仓库巡检报告 (2026-05-07 17:01)`
- 收口后当前未归档状态已降到：
  - `hermes-default`: `in_progress=14`, `pending=3`
  - `hermes-ops`: `in_progress=0`, `pending=0`
- 明日重点观察口径：
  - `startup_rate`
  - `first_heartbeat_rate`
  - `completion_rate`
  - `validation_pass_rate`
  - `failure_buckets.no_heartbeat`
- 统一观测命令：
  - `node scripts/query_ops_baseline.js`

**default 进行中任务的库侧核验（2026-05-07）：**

- 已新增库核验脚本：
  - `python3 scripts/query_default_db_evidence.py`
  - `node scripts/audit_default_in_progress.js`
- 当前 `hermes-default` 的 `14` 个 `in_progress` 里，不是全部都没做；从目标库最终状态看，至少有一部分业务结果已经满足：
  - `daily_quote` 最新 `trade_date = 2026-05-07`，最新日期行数 `5493`
  - `fact_adj_factor` 最新 `trade_date = 2026-05-07`，最新日期行数 `5519`
  - `index_daily` 最新 `trade_date = 2026-05-06`，最新日期行数 `7`
- 但以下链路从库结果看仍明显未完成或未落到目标表：
  - `fact_margin` 只到 `2026-04-30`
  - `fact_stk_limit` 只到 `2026-04-30`
  - `fact_hk_hold / fact_hsgt_top10` 当前为空表
  - `tushare_moneyflow.duckdb` 当前无业务表
  - `tushare_block_trade_v2.duckdb` 当前无业务表
- 因此后续处理口径应区分：
  - 可以按库证据收口的任务
  - 库里也未完成、需要继续驱动或转阻塞的任务

**数据任务统一结果验收（2026-05-07 已落地）：**

- 已新增 `todos.task_spec` 结构化字段，模板和实例共用，用于固定：
  - 目标库路径
  - 数据引擎类型（`duckdb / sqlite`）
  - 目标表 / 日期字段
  - 验收 SQL 列表
- 已新增纯规则 `DataTaskValidationService`：
  - 数据任务进入 `pending_validation` 后，优先直接执行目标库校验
  - 所有 SQL 检查通过才允许进入 `completed`
  - 不再让 LLM 判断“数据任务是不是完成了”
- 已把 `TemplateNormalizationService` 扩展为数据模板规则补齐：
  - 已知数据模板会自动补 `task_spec`
  - 数据模板默认验收标准改为“目标库 + 最新日期 + 最新日期行数 + 库校验 SQL”
  - 在规则足够时直接跳过 LLM，不再为了模板补全再发一次模型请求
- 已执行模板升级脚本：
  - `node scripts/upgrade_default_data_task_specs.js`
  - 当前开发库 `hermes-default` 下 `14` 个数据模板已全部补齐 `task_spec`
  - 同步补齐了 `18` 个仍未归档的实例任务字段，避免新老口径并存
- 新增回归测试：
  - `tests/data-task-validation.test.js`
  - `tests/template-normalization.test.js`
  - `tests/todo.test.js`
- 这批改造解决的核心问题：
  - 已落库但任务未收口
  - 未落库却长期挂在 `in_progress`
  - 数据任务完成判断依赖心跳/描述而非结果
  - 模板升级后再次丢失目标库口径

**数据任务强制驱动闭环增强（2026-05-08 已落地）：**

- 已把 `DataTaskSpecService` 升级为数据任务规范源：
  - 已知数据任务模板会固定输出正式目标库、正式校验 SQL、正式执行脚本
  - 实例上残留的旧 `path / table / checks` 不再优先于规范规格，避免历史脏规格反复误判
- 已为默认数据任务补“正式脚本绑定”，驱动时优先执行正式采集/同步脚本，而不是让智能体临时生成替代脚本：
  - `fetch_daily_tushare.py`
  - `daily_update_wrapper.py`
  - `fetch_adj_factor_v2.py`
  - `fetch_dividend_v2.py`
  - `fetch_block_trade_v2.py`
  - `fetch_index_daily_v2.py`
  - `fetch_hsgt_hk_hold.py`
  - `fetch_stk_limit.py`
  - `fetch_margin.py`
  - `fetch_margin_detail.py`
  - `fetch_moneyflow_v2.py`
  - `fetch_top_list.py`
- 已把 `DriveOrchestrator` 接成“正式脚本优先”：
  - 命中数据任务时先走正式脚本
  - 脚本执行成功后直接进入规则验收
  - 只有没有正式脚本绑定的任务才继续走原有 LLM/工具驱动链
- 已把手动 `POST /api/agents/:agentId/todos/:id/drive` 优先切到 `DriveOrchestrator.triggerTaskDrive()`，避免手动驱动回退到旧的 `framework.processMessage()` 文本链路
- 已给 `DataTaskValidationService` 增加 SQL 方言自适应：
  - DuckDB/SQLite 共用一套验收规格时，会自动改写 `strftime(CURRENT_DATE - INTERVAL ...)` 等日期表达式
  - 避免 DuckDB 风格 SQL 去验证 SQLite 目标库时直接报错
- 已给源头空数据场景补“延期验收”规则：
  - 当前已对 `hsgt`、`margin`、`margin_detail` 接入 Tushare 源头探测
  - 若源头在目标日期返回 `0` 行，则本轮不记为 `validation_failed`
  - 任务会自动回到等待下次调度的状态，并写入延期原因
- 这批改造的目标不是让 LLM 继续高频盯执行细节，而是把执行、验收、延期判定都尽量收回到规则和正式脚本上，让 LLM 只保留在真正需要的兜底环节
- 新增/更新回归测试：
  - `tests/data-task-validation.test.js`
  - `tests/drive-orchestrator.test.js`
  - `tests/template-normalization.test.js`
  - `tests/todo.test.js`

**页面任务口径修正（2026-05-08 已落地）：**

- Agent 面板继续保留“定时任务”独立区域，专门展示模板任务
- 常规任务列表改为“今日日常任务”，只展示当天新生成的实例任务
- 默认不再把昨天遗留实例和模板任务混在同一个常规列表里，避免凌晨看到 `0508` 任务时误以为已经提前调度
- 列表后端新增 `todayOnly` 过滤口径，按当前机器本地时间判断 `created_at` 是否属于今天
- 今日日常任务卡片额外显示“今日生成时间”和“来源模板”，方便快速区分这条实例是今天几点生成、由哪个模板派生
- 补充修复：全局任务列表对“来源模板但模板本身不在 todayOnly 返回集内”的子任务，改为直接展示子任务本身，避免 `每日 A股日线数据增量同步（Tushare）` 这类今日已生成实例从列表中漏掉
- 补充修复：本地开发态 Dashboard 的静态页面和 `fetch` 请求统一禁缓存，避免浏览器继续拿旧版 `index.html` / 旧版 `todayOnly` 响应，导致任务列表与数据库状态不一致
- 补充修复：本地开发态 `/api/*` 响应同样禁缓存，确保任务列表、统计卡片与数据库实时状态一致

**17:00 批量数据模板漏跑修正（2026-05-08 已落地）：**

- 根因确认：`DailyScheduler` 在“模板到点生成实例”前就套用了 `Agent.canAcceptNewTask()`，把 agent 执行并发上限误当成了实例生成门槛
- 直接后果：`hermes-default` 当时已有 `5` 个执行中任务时，`top_list / adj_factor / block_trade / hsgt / stk_limit / index_daily / daily_quote+daily_basic / stock.db` 等模板虽然已到期，但被持续记成 `task_spawn_skipped(agent_capacity_reached)`，页面自然只看到少量实例
- 修正规则：调度治理层保留“同模板活跃实例限制”和“短时 burst 限流”，但默认不再用 agent 执行并发上限阻断模板实例落库；执行并发继续由后续 drive / 运行态控制
- 已补回归测试：覆盖“agent 槽位已满时仍允许 scheduler 生成实例”和“需要时仍可显式启用 capacity 硬阻塞”两条路径
- 当晚加速补齐：对 `Tushare / dividend / moneyflow / top_list / adj_factor / block_trade / hsgt / stk_limit / index_daily / daily_quote+daily_basic / stock.db` 这组收盘模板追加 `SCHEDULE_BURST_LIMIT=8`、`SCHEDULE_BURST_WINDOW_MINUTES=5`，只放宽该组模板的补发速度，不改全局默认值
- 运行态验证：`top_list / adj_factor / block_trade / hsgt / stk_limit / index_daily / daily_quote+daily_basic / stock.db` 已在后续调度周期内陆续生成当天实例；当前剩余主要卡点已转为执行链 `blocked`，不再是“到点不生成”

**数据任务正式执行链修正（2026-05-08 已落地）：**

- 根因 1：`DataTaskSpecService` 之前把正式脚本包装成 `source run_index.sh && python3 script.py`，但 `run_index.sh` 在 `source` 时会直接执行 `fetch_index_daily_v2.py`，导致目标脚本被副作用脚本串扰，失败后还会把真实报错吞掉
- 根因 2：`bash -lc` 登录 shell 内的 `python3` 实际解析到 `/usr/bin/python3`，缺少 `tushare` 依赖；同一台机器非登录 shell 的 `python3` 才是可用解释器
- 修正规则：正式脚本执行统一改成“从 `~/.openclaw/workspace/stock_backfill/.token` 注入 `TUSHARE_API_TOKEN/TUSHARE_TOKEN` + 使用固定绝对路径 Python 解释器 + 直接执行目标脚本”，不再依赖 `source run_index.sh`
- 验收 SQL 修正：`trade_date` 类检查统一改为 `REPLACE(CAST(trade_date AS VARCHAR), '-', '')` 再参与比较，避免 DuckDB 中 `2026-05-07` 与 `20260507` 口径不一致导致误判
- 规则匹配修正：`每日 A股日线数据全量采集（daily_quote + daily_basic）` 的 preset 提前到通用 `daily_quote` 规则前，避免被宽泛匹配截胡后丢失 `execution`
- 脚本参数修正：`fetch_daily_tushare.py` 补齐 `--days 1`，避免脚本因缺少 `--full-backfill / --days / --trade-date` 之一直接退出
- 已补单测：覆盖正式脚本命令构造、`trade_date` 归一化检查、`daily_quote + daily_basic` 匹配优先级与 `--days 1` 参数绑定
- 运行态验证：`每日涨跌停数据增量同步（stk_limit）`、`每日指数日线数据增量同步（index_daily）`、`每日 A股日线数据全量采集（daily_quote + daily_basic）`、`每日大宗交易数据增量同步（block_trade）`、`每日沪深港通数据增量同步（hsgt）`、`每日复权因子数据增量同步（adj_factor）`、`每日分红数据增量同步（dividend）`、`每日龙虎榜数据增量同步（top_list）`、`每日资金流向数据增量同步（moneyflow）`、`每日 A股数据同步到 SQLite stock.db` 已在新执行链或修正后的本地服务执行链下成功跑脚本并通过规则验收，从 `blocked/no_heartbeat` 收口为 `completed`
- 补充桥接修正：`todo_bridge.py` 现在优先复用“今天新生成且最新”的模板实例，不再把正式脚本心跳错误绑定到昨天遗留的 `in_progress/blocked` 旧实例；同时服务端 `/heartbeat` 已兼容桥接脚本上报的 `message` 字段，避免心跳文本被吞掉
- 根治补强：TODO Server 正式脚本执行链现在会显式注入 `TODO_TASK_ID / TODO_AGENT_ID`，`todo_bridge.py` 若检测到当前任务 ID 就直接回写该实例，不再依赖模板标题匹配或活跃实例猜测；`stock.db` 这类脚本桥接不再会误绑到历史遗留任务
- 运行前收敛：`DriveOrchestrator` 在正式脚本执行前会自动归档同模板下其它 `pending / in_progress / blocked / pending_validation / validating` 旧实例，只保留当前执行实例，减少历史僵尸任务继续污染页面和桥接目标
- 恢复脚本入口：已新增 `npm run recover:market`，会基于开发库中“今天最新生成”的 `stock.db / block_trade / hsgt / adj_factor / dividend / top_list / moneyflow` 实例，逐条执行“归档旧实例 -> 强制 drive -> 输出结果摘要”的恢复流程，便于剩余股市任务批量收口
- 服务化收敛：已新增 `MarketTaskRecoveryService` 统一封装“筛选今天最新实例 / 跳过已完成任务 / 归档同模板旧实例 / 调用强制 drive”的恢复逻辑，脚本入口和后续潜在 API 入口都复用同一条链路，避免恢复规则再次分叉
- 本地 API 入口：已新增 `POST /api/agents/:agentId/todos/recover-market`，本地开发态免登下可直接触发这 7 条剩余股市数据任务的批量恢复；若传 `titles` 数组，也可只恢复指定子集
- `stock.db` 补充修正：`daily_update_wrapper.py` 现在会把当前 `task_id` 显式传入子 shell；`daily_update.sh` 的 `todo_report_safe()` 会优先使用 `TODO_TASK_ID`，不再依赖旧缓存任务 ID；`todo_report.sh` 也已改为优先读取环境变量中的 `TODO_TASK_ID`
- `stock.db` 执行链补充修正：`daily_update.sh` 里的 `fetch_daily_tushare.py / sync_tushare_to_stock_db.py / DuckDB 验证` 已统一切换到固定解释器 `DATA_TASK_PYTHON`（默认 `/opt/anaconda3/bin/python`），不再受 shell 默认 `python3` 指向影响；本次已修复 `ModuleNotFoundError: No module named 'tushare'`
- 巡检验收补强：`CompletionReportBuilder` 现在会直接读取 `~/.openclaw/workspace/tushare_warehouse/reports/daily_inspection_YYYY-MM-DD.json`，为 `每日 DuckDB 数据仓库巡检` 自动生成结构化 `completion_report`；`ValidationPolicyService` 在巡检任务缺少 `completion_report` 时也会自动回填并按 inspection policy 验收
- 巡检运行态收口：`每日 DuckDB 数据仓库巡检` 已基于当日巡检报告（`total=15 / ok=11 / warning=2 / error=0 / static=2`）从 `validation_failed` 收口为 `completed`；warning 项为 `分红数据` 与 `财务指标`，当前不构成阻断
- 最新 freshness 根因复盘：`fetch_stk_limit.py / fetch_top_list.py / fetch_hsgt_hk_hold.py / fetch_block_trade_v2.py` 之前都把增量终点硬编码到“昨天”，即使 `2026-05-08` 源头已出数，也会天然停在 `2026-05-07`
- 同日验收口径修正：`DataTaskSpecService` 已把 `block_trade / hsgt / stk_limit / top_list` 改成同日严格校验（`lagDays=0`）并补上同日 `sourceProbe`；`DataTaskValidationService` 不仅 JS 层 `normalizeLagDays()` 支持 `0`，内嵌 Python probe 也已修复，不再把 `0` 吞回 `1`
- 历史实例规格刷新：`Todo` 模型在读取任务时现在会自动把实例上残留的旧 `task_spec` 与当前 canonical preset 合并，返回给页面、drive、validation、恢复链的都是最新规格；旧实例不再继续暴露 `INTERVAL 1 DAY`、旧目标表名或旧目标库路径
- 执行脚本补丁继续收口：`fetch_stk_limit.py` 已修复“最近开放交易日排序”以及增量分支遗漏 `table` 参数导致脚本直接报错的问题；`MarketTaskRecoveryService` 也已把 `stk_limit` 纳入 `recover-market` 默认恢复集合，避免后续批量恢复时再次漏掉
- 宿主运行态复核：由于 sandbox 直接写 DuckDB 仍会遇到 `Operation not permitted`，本次改为通过 PM2 宿主进程执行正式脚本并复核目标库；当前最新结果已更新为：
  - `block_trade`：最新 `2026-05-08`，最新日 `133` 行
  - `top_list`：最新 `2026-05-08`，最新日 `103` 行
  - `stk_limit`：最新 `2026-05-08`，最新日 `7580` 行
  - `hsgt_top10`：最新 `2026-05-08`，最新日 `20` 行
  - `hk_hold`：源头 `2026-05-08` 返回 `0` 行，当前仍停在 `2026-05-07 / 925` 行，后续应按“`top10` 同日严格、`hk_hold` 允许延期”处理
- `hsgt` 口径显式化：当前 `task_spec.validation` 已支持 `sourceProbes` 数组；`hsgt` 明确只对 `hk_hold` 两个 freshness label 绑定 `hk_hold` 源头探测和延期逻辑，`fact_hsgt_top10_*` 不在可延期集合内，因此 `top10` 若仍停在昨天会直接失败，不会再被 `hk_hold=0` 的特例掩盖
- 今日完成率口径修正：`2026-05-08` 的 `hermes-default` 非模板任务最终结果仍是 `13/13 completed`、完成率 `100%`、且 `13/13` 已带验证结果；但这明确是“修复脚本 / bridge / 验收规则并人工重驱后的最终结果”，不能当作“自然调度已稳定达到 90%+”的证明
- 自然调度仍未达 90% 的已确认链路：17:00 模板实例生成曾被 capacity 门槛误挡、正式脚本执行链曾受解释器/bridge 旧链路影响、freshness 旧规则默认允许“到昨天也算通过”、`recover-market` 之前遗漏 `stk_limit`、以及 `manual_api` / `forced_drive` 还有按 source 计数的尝试上限，这些都属于自然完成率仍需继续收口的系统问题

**股市定时任务跨天补跑修正（2026-05-08 已落地）：**

- 修复了 `findDueTemplates(..., { reconcile: true })` 在服务夜间恢复后会把“昨天下午 17:00-18:00 的股市日任务”在次日凌晨补生成的问题
- 新规则：股市类收盘任务一旦跨过本地自然日，直接顺延到下一个调度时点，不再在凌晨执行补跑
- 补充修正了时间根因：SQLite `CURRENT_TIMESTAMP` 写入的 UTC 裸时间现在统一按 UTC 解析，模板 `last_spawned_at` 也改为 ISO 时间，避免调度基准被本地时区误读
- 本次已撤回凌晨误生成的 `每日 A股日线数据增量同步（Tushare）`、`每日分红数据增量同步（dividend）`、`每日资金流向数据增量同步（moneyflow）`、`每日龙虎榜数据增量同步（top_list）`、`每日复权因子数据增量同步（adj_factor）` 实例
- 运行态复核已完成：`localhost:3000` 新进程加载修正后，当前 `hermes-default` 的“今日日常任务”只剩巡检任务，股市模板当前不再被判定为 due

**本地 Dashboard 免登（2026-05-08 已落地）：**

- 对 `localhost / 127.0.0.1` 访问放开本地 Dashboard 免登线：
  - 本机访问 `/api/agents` 与 `/api/agents/:agentId/...` 时默认跳过 `X-Agent-Secret` 校验
  - 本机访问 `/api/*` 时默认跳过开发期限流，避免 agent 列表被 `429` 打空
- 前端在本机访问时会自动选择可用 Agent（优先 `hermes-default`）直接进入 Dashboard，不再弹出登录面板
- 这条免登线仅用于本机开发访问；若设置 `DISABLE_LOCAL_DASHBOARD_BYPASS=1`，可恢复原始鉴权行为

#### 阶段二：调度与执行中台收敛

**目标：** 将分散在 `server.js` 中的监控、恢复、调度逻辑抽离为统一调度器，降低复杂度，减少不同 job 之间互相踩踏。

**建议周期：** 2-4 天

**核心改造：**

- 抽象统一 Scheduler / JobRegistry 管理以下任务：
  - `StuckTaskMonitor`
  - `ZombieDetector`
  - `DriveOrchestrator`
  - `LLMInferencer`
  - `DailyScheduler`
  - `AssignmentDriver`
  - `CronExecutionMonitor`
  - `GlobalCleanup`
  - `CleanupMonitor`
- 每个 job 明确定义：
  - 名称
  - 扫描间隔
  - 是否允许重入
  - 最大并发
  - 日志标签
  - 错误处理方式
- 区分驱动类 job 与清理类 job 的优先级，减少同任务多处同时修改状态的竞态风险
- 为后续按模块测试和按 job 启停留接口

**阶段二验收标准：**

- `server.js` 主要负责应用启动与注册，不再承载大段定时业务逻辑
- 每个调度任务可以独立测试和单独观察日志
- 同一任务不会因多个定时器重叠而被重复驱动或重复恢复
- 运行日志能明确定位到具体 job 引发的状态变化

#### 阶段三：安全、质量与产品化补强

**目标：** 在执行主链稳定后，补齐安全、持久化、测试和文档层短板，把系统从“能跑”提升为“能长期维护”。

**建议周期：** 2-5 天

**核心改造：**

- 认证中间件改为 timing-safe 比较，修复 `secret_key` 直接比较风险
- 清理 `MemoryManager` 对 `localStorage` 的 Node 端伪持久化依赖，改为真实文件或数据库存储
- 增加面向执行闭环的集成测试，而非仅补静态单测
- 将 README 收敛为“项目定位摘要 + 指向主文档”，避免继续传播旧阶段信息
- 补充关键 API 请求/响应示例，提升接入可用性

**阶段三验收标准：**

- 核心执行链至少具备 2-3 个高价值集成测试场景
- README 与主文档定位一致，不再混杂已废弃文档入口
- 关键安全问题和持久化短板完成落地修复
- 失败时能够快速定位问题发生在执行层、调度层还是验收层

### 15.8 建议的第一阶段任务拆解

为避免一次性改动过大，阶段一建议拆成以下 5 个子任务按顺序实施：

1. **定义统一工具协议**：明确 drive 模式下的工具集、消息格式、轮次上限和预算策略
2. **打通 Framework tools 执行链**：确保 `Framework` / `LLMManager` 在 drive 模式下稳定支持工具调用与结果回灌
3. **重构 `DriveOrchestrator.driveTask()`**：实现多轮 Agent Loop 主流程
4. **保留 fallback 通路**：旧的命令提取逻辑仅作为兜底，加入命中率与回退原因记录
5. **补测试与文档**：增加执行闭环测试，并同步维护主文档与 README

### 15.9 当前不建议优先投入的方向

在阶段一完成之前，以下方向不建议作为当前主投入：

- Web UI 深度完善
- WebSocket / SSE 实时推送
- 监控面板和可视化看板
- Streaming 交互体验优化
- 新的外围协作功能

原因不是这些方向不重要，而是它们的收益建立在“自动执行主链稳定可用”这一前提之上。先补外围能力，只会放大底层执行链的不稳定性。
