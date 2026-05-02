# ExecutionGuard 方案设计

> 版本: 1.0
> 日期: 2026-05-02
> 状态: ✅ 已实现

---

## 一、问题描述

### 现状

TODO Server 的任务执行依赖 `agent-worker.js` 自托管进程自驱。agent-worker 每 30 秒 poll focus_states，调用 LLM 生成命令并执行。但整个链路是**开环**的：

```
server 存 focus → worker 选 poll → LLM 决定干嘛 → 可能执行也可能不执行
```

### 具体表现

| 场景 | 问题 |
|---|---|
| agent-worker 进程未启动 | 所有任务完全无人执行 |
| LLM 回复不含 bash 命令 | worker 记录了活动但任务无实质进展 |
| LLM 回复为空/错误 | worker 无法解析，直接跳过 |
| 命令执行失败 | 无重试，worker 直接等待下一轮 |
| 指派给其他 agent | 被指派 agent 的 worker 不一定在线 |

### 根本原因

**没有模块对"任务是否真正执行了"负责。** 所有机制（focus、drive、work loop）都是建议性的，没有强制执行闭环。

---

## 二、目标

```
drive → execute → validate → retry → escalate
```

1. **强制执行**：不依赖 agent-worker，server 内置执行引擎
2. **闭环验证**：执行后必须验证 progress 是否变化
3. **自动重试**：无变化时自动重试（最多 3 次）
4. **失败升级**：重试耗尽后标记 stalled 并通知人工
5. **全链路可观测**：每个步骤记录到 contexts 表

---

## 三、架构设计

### 3.1 目标执行链路

```
┌──────────────────────────────────────────────────────────┐
│  server.js (DriveOrchestrator)                            │
│                                                          │
│  每 60s 扫描                                             │
│    ├─ FocusState.findByAgent() → 所有有 focus 的 agent    │
│    ├─ 对每个 focused task (pending/in_progress)           │
│    │    ├─ ProgressValidator.snapshot() → 执行前快照       │
│    │    ├─ buildDrivePrompt() → 构建 work prompt          │
│    │    ├─ framework.processMessage(prompt) → LLM 回复    │
│    │    ├─ CommandExecutor.extractAndRun(reply) → 执行命令 │
│    │    ├─ ProgressValidator.compare() → 对比前后          │
│    │    │    ├─ 有变化 → 记录成功，继续下一轮               │
│    │    │    └─ 无变化 → 重试（追加上次失败上下文）          │
│    │    ├─ 重试 3 次仍无变化 → 标记 stalled + 通知         │
│    │    └─ 全程记录到 contexts                              │
│    └─ 继续下一个 agent                                     │
│                                                          │
│  闭环保证：                                               │
│  ✅ 强制执行（不依赖 agent-worker）                        │
│  ✅ 重试机制（3次，追加上下文）                             │
│  ✅ Progress 验证（执行后必须验证变更）                     │
│  ✅ 升级机制（stalled → 通知）                             │
│  ✅ 全链路可观测（contexts 全记录）                         │
└──────────────────────────────────────────────────────────┘
```

### 3.2 与现有模块关系

```
                    ┌─────────────────────┐
                    │   AssignmentDriver   │ ← 指派后自动 focus
                    └─────────┬───────────┘
                              │ focus 已设置
                              ▼
                    ┌─────────────────────┐
                    │  DriveOrchestrator   │ ← 每 60s 扫描，强制执行
                    │  （新增，核心）        │
                    └─────────┬───────────┘
                              │ drive + execute + validate
                              ▼
              ┌───────────────────────────────┐
              │                               │
    ┌─────────▼─────────┐          ┌──────────▼──────────┐
    │   CommandExecutor  │          │  ProgressValidator   │
    │   （新增）          │          │  （新增）             │
    │  命令提取+安全执行   │          │  执行前后对比         │
    └─────────┬─────────┘          └──────────┬──────────┘
              │                               │
              └───────────┬───────────────────┘
                          │ 闭环验证
                          ▼
              ┌───────────────────────────────┐
              │  StuckTaskMonitor（已有）       │ ← 最终兜底
              └───────────────────────────────┘
```

---

## 四、新增模块详细设计

### 4.1 CommandExecutor（命令执行器）

**文件**: `src/services/CommandExecutor.js`

**职责**: bash 命令提取 + 安全执行，从 agent-worker.js 中提取并增强。

```javascript
class CommandExecutor {
  /**
   * 从 LLM 回复中提取 bash 命令块
   * @param {string} reply - LLM 回复内容
   * @returns {Array<{ index: number, command: string }>}
   */
  static extractBashBlocks(reply) { }

  /**
   * 执行一组命令
   * @param {Array} commands - [{ index, command }]
   * @param {object} opts - { timeoutMs, cwd, maxCommands }
   * @returns {Array<{ command, output, success, duration }>}
   */
  static async executeCommands(commands, opts = {}) { }

  /**
   * 构建执行摘要
   * @param {Array} results - 执行结果
   * @returns {string}
   */
  static buildExecutionSummary(results) { }

  /**
   * 提取+执行一步到位
   */
  static async extractAndRun(reply, opts) { }
}
```

**关键设计点**:
- 正则支持 ` ```bash ` / ` ```shell ` / ` ```sh ` 三种代码块
- 执行超时：基于 `expected_duration_minutes` 动态计算（最小 30s，最大 10min）
- 单次最多执行 3 个命令
- 每个命令记录执行耗时
- 失败时捕获 stdout/stderr 作为重试上下文

**来源**: 从 `agent-worker.js` 的 `_executeBashBlocks()` 方法提取，消除重复代码。

### 4.2 ProgressValidator（进度验证器）

**文件**: `src/services/ProgressValidator.js`

**职责**: 执行前后 progress 快照对比，判断任务是否真正有进展。

```javascript
class ProgressValidator {
  /**
   * 执行前快照
   * @param {object} task - 任务对象
   * @returns {{ progress: number, step: string, blockers: string, updatedAt: string }}
   */
  static snapshot(task) { }

  /**
   * 对比前后快照
   * @param {object} before - 执行前快照
   * @param {object} after - 执行后快照
   * @returns {{ changed: boolean, delta: object }}
   */
  static compare(before, after) { }

  /**
   * 构建验证报告（记录到 contexts）
   */
  static buildReport(taskId, before, after, result) { }
}
```

**变更判定规则**:
- `progress` 数值变化 → 有进展
- `step` 文本变化 → 有进展
- `blockers` 文本变化 → 有进展（可能是新增了 blocker，也视为活动）
- 三个字段都没变 → 无进展 → 触发重试

### 4.3 DriveOrchestrator（执行编排器）

**文件**: `src/services/DriveOrchestrator.js`

**职责**: 闭环执行引擎，是 ExecutionGuard 的核心模块。

```javascript
class DriveOrchestrator {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3;
    this.retryBackoffMs = options.retryBackoffMs || [0, 5000, 15000];
    this.driveCooldownMs = options.driveCooldownMs || 60 * 1000;
    this.maxConcurrentDrives = options.maxConcurrentDrives || 3;
    this.stallThreshold = options.stallThreshold || 30 * 60 * 1000;
    this.drivingTasks = new Set();  // 当前正在执行的 task id
  }

  /**
   * 主循环入口，由 setInterval 调用
   * @returns {{ driven: number, retried: number, stalled: number }}
   */
  async tick() { }

  /**
   * 驱动单个任务执行
   * @param {string} agentId
   * @param {object} task
   * @returns {{ success: boolean, attempts: number, result: object }}
   */
  async driveTask(agentId, task) { }

  /**
   * 构建 work prompt
   * @param {object} task
   * @param {string|null} retryContext - 上次失败的上下文
   * @returns {string}
   */
  buildDrivePrompt(task, retryContext = null) { }

  /**
   * 检查任务是否应该被 drive
   */
  shouldDrive(task) { }

  /**
   * 状态预处理：pending→in_progress, blocked→恢复
   */
  async prepareTaskState(agentId, task) { }
}
```

#### tick() 流程

```
tick()
│
├─ 获取所有 agent
├─ driven = 0, retried = 0, stalled = 0
│
├─ 对每个 agent:
│   ├─ FocusState.findByAgent(agentId) → focus
│   ├─ 如果没有 focus → 跳过
│   ├─ Todo.findById(agentId, focus.currentTaskId) → task
│   ├─ shouldDrive(task)?
│   │    ├─ task.status 不在 ['pending','in_progress'] → 跳过
│   │    ├─ task.last_driven_at 距今 < cooldownMs → 跳过
│   │    └─ drivingTasks.has(task.id) → 跳过（正在执行）
│   ├─ drivingTasks.add(task.id)  ← 加锁
│   ├─ try { result = await driveTask(agentId, task); driven++ }
│   └─ finally { drivingTasks.delete(task.id) }  ← 释放
│
├─ 检查 stalled 阈值
│   ├─ 遍历所有 in_progress 任务
│   └─ last_heartbeat 距今 > stallThreshold → 标记 stalled, stalled++
│
└─ return { driven, retried, stalled }
```

#### driveTask() 流程

```
driveTask(agentId, task)
│
├─ 1. 状态预处理
│   ├─ pending → in_progress
│   └─ blocked + 有重试余量 → in_progress
│
├─ 2. 执行循环（最多 MAX_RETRIES 次）
│   │
│   ├─ snapshot = ProgressValidator.snapshot(task)
│   │
│   ├─ retryContext = null (首次)
│   │
│   ├─ for attempt in [0..maxRetries):
│   │   │
│   │   ├─ sleep(retryBackoffMs[attempt])  // 退避
│   │   │
│   │   ├─ prompt = buildDrivePrompt(task, retryContext)
│   │   │
│   │   ├─ Context.create()  // 记录 drive 请求
│   │   │
│   │   ├─ reply = framework.processMessage(prompt)
│   │   │
│   │   ├─ Context.create()  // 记录 LLM 回复
│   │   │
│   │   ├─ commands = CommandExecutor.extractBashBlocks(reply)
│   │   │
│   │   ├─ if commands.length > 0:
│   │   │   ├─ results = CommandExecutor.executeCommands(commands)
│   │   │   └─ Context.create()  // 记录执行结果
│   │   │
│   │   ├─ 解析 heartbeat 变更（从 reply 或 results 推断）
│   │   ├─ Todo.update() + Todo.updateHeartbeat()
│   │   │
│   │   ├─ 刷新 task = Todo.findById()  // 获取最新状态
│   │   ├─ after = ProgressValidator.snapshot(task)
│   │   │
│   │   ├─ { changed } = ProgressValidator.compare(snapshot, after)
│   │   │
│   │   ├─ if changed:
│   │   │   ├─ Context.create()  // 记录成功
│   │   │   ├─ Todo.update({ last_driven_at: now })
│   │   │   └─ break  // ✅ 成功，退出循环
│   │   │
│   │   └─ if !changed:
│   │       ├─ retryContext = buildRetryContext(reply, results, attempt)
│   │       └─ continue  // 重试
│   │
│   └─ 3. 重试耗尽
│       ├─ heartbeat.step = "等待人工介入"
│       ├─ Notification.create()  // 通知
│       ├─ Context.create()  // 记录 stalled
│       └─ return { success: false, attempts: maxRetries }
│
└─ return { success, attempts, result }
```

---

## 五、现有模块改动

### 5.1 Todo 表新增字段

```sql
ALTER TABLE todos ADD COLUMN last_driven_at TEXT;
```

**用途**: 记录最后一次被 drive 的时间戳，用于防冲突（cooldown 检查）。

### 5.2 drive 路由增强 (`POST /:id/drive`)

**当前问题**: 只做 LLM 推理 + heartbeat 解析，不执行 bash 命令。

**增强后**:

```
POST /:id/drive 增强流程:

1. 状态处理（不变）
2. 【新增】执行前快照 = ProgressValidator.snapshot(task)
3. 构建 prompt（不变）
4. 调用 LLM（不变）
5. 【新增】提取 bash 命令 → CommandExecutor.extractAndRun(reply)
6. 【新增】解析 heartbeat（增强：结合 LLM 回复 + 命令执行结果）
7. 【新增】执行后快照 + ProgressValidator.compare()
8. 【新增】记录 last_driven_at
9. 返回完整结果（增加 commands_executed, progress_changed 字段）
```

### 5.3 agent-worker.js 重构

**改动**: 将 `_executeBashBlocks()` 方法重构为调用 `CommandExecutor`。

```javascript
// 改动前
async _executeBashBlocks(task, reply) {
  const bashRegex = /```(?:bash|shell)\n([\s\S]*?)```/g;
  // ... 40+ 行执行逻辑
}

// 改动后
async _executeBashBlocks(task, reply) {
  const commands = CommandExecutor.extractBashBlocks(reply);
  if (commands.length === 0) return null;
  const timeoutMs = this._calcTimeout(task);
  const results = await CommandExecutor.executeCommands(commands, { timeoutMs, cwd: process.env.HOME });
  await this._recordActivity('command_exec', CommandExecutor.buildExecutionSummary(results), task.id);
  return results;
}
```

**目的**: 消除 agent-worker 与 DriveOrchestrator 之间的命令执行逻辑重复，确保两者行为一致。

### 5.4 server.js 注册 DriveOrchestrator

```javascript
// 与 StuckTaskMonitor / AssignmentDriver 同级
const DriveOrchestrator = require('./services/DriveOrchestrator');

const driveOrchestrator = new DriveOrchestrator({
  intervalMs: 60 * 1000,
  maxRetries: 3,
  retryBackoffMs: [0, 5000, 15000],
  driveCooldownMs: 60 * 1000,
  stallThreshold: 30 * 60 * 1000,
});

setInterval(async () => {
  const result = await driveOrchestrator.tick();
  if (result.driven > 0 || result.stalled > 0) {
    console.log(`[DriveOrchestrator] driven=${result.driven} retried=${result.retried} stalled=${result.stalled}`);
  }
}, driveOrchestrator.intervalMs);
```

---

## 六、防冲突机制

多个执行者（DriveOrchestrator + agent-worker + 手动 drive）可能同时操作同一个任务。

### 6.1 三级防冲突

| 层级 | 机制 | 适用场景 |
|---|---|---|
| **时间锁** | `last_driven_at` cooldown（60s） | DriveOrchestrator vs agent-worker |
| **内存锁** | `drivingTasks` Set（per process） | DriveOrchestrator 内部并发 |
| **状态保护** | heartbeat.step 包含"执行中"标记 | 手动 drive 优先级最高 |

### 6.2 优先级

```
手动 drive (POST /:id/drive) > DriveOrchestrator > agent-worker
```

- 手动 drive 忽略 cooldown 和内存锁（人工操作始终优先）
- DriveOrchestrator 检查 cooldown 和内存锁
- agent-worker 检查 `last_driven_at`，如果近期已被 drive 则跳过

---

## 七、数据流图

```
┌─────────────┐
│ FocusState  │ ← autoFocus / AssignmentDriver / 手动
│ (currentTask)│
└──────┬──────┘
       │
       ▼
┌─────────────────┐    ┌─────────────────┐
│ DriveOrchestrator│───→│ ProgressValidator│
│ .tick()          │    │ .snapshot()      │
└──────┬──────────┘    └────────┬────────┘
       │                        │ 执行前快照
       ▼                        │
┌─────────────────┐             │
│ buildDrivePrompt│             │
└──────┬──────────┘             │
       │                        │
       ▼                        │
┌─────────────────┐             │
│ framework       │             │
│ .processMessage │             │
└──────┬──────────┘             │
       │ LLM reply              │
       ▼                        │
┌─────────────────┐             │
│ CommandExecutor │             │
│ .extractAndRun  │             │
└──────┬──────────┘             │
       │ commands + results     │
       ▼                        │
┌─────────────────┐             │
│ Todo.update     │             │
│ Heartbeat       │             │
└──────┬──────────┘             │
       │                        ▼
       │              ┌─────────────────┐
       │              │ ProgressValidator│
       │              │ .compare()       │
       │              └────────┬────────┘
       │                       │
       │              ┌────────▼────────┐
       │              │ changed?         │
       │              └───┬─────────┬───┘
       │                  │         │
       │               yes│         │no
       │                  ▼         ▼
       │           ┌──────────┐ ┌──────────┐
       │           │ ✅ 成功   │ │ 🔄 重试   │
       │           └──────────┘ └─────┬────┘
       │                              │ 超过3次
       │                              ▼
       │                       ┌──────────┐
       │                       │ ⚠ stalled │
       │                       │ 通知人工  │
       │                       └──────────┘
       ▼
┌─────────────────┐
│ Context.create  │ ← 全链路记录
└─────────────────┘
```

---

## 八、配置参数

```javascript
const DRIVE_ORCHESTRATOR_CONFIG = {
  intervalMs: 60 * 1000,              // 扫描间隔（60s）
  maxRetries: 3,                       // 每次 drive 最大重试次数
  retryBackoffMs: [0, 5000, 15000],    // 重试退避（首次立即，然后 5s, 15s）
  driveCooldownMs: 60 * 1000,          // 同一任务 drive 最小间隔（60s）
  maxConcurrentDrives: 3,              // 同时最多驱动 3 个任务
  stallThreshold: 30 * 60 * 1000,      // 30 分钟无 progress → stalled
  maxBashCommands: 3,                  // 每次 drive 最多执行 3 个命令
  commandTimeoutMultiplier: 0.25,      // 命令超时 = 预估耗时 × 0.25
  commandTimeoutMinMs: 30000,          // 命令最小超时 30s
  commandTimeoutMaxMs: 600000,         // 命令最大超时 10min
};
```

---

## 九、实施步骤

| 步骤 | 内容 | 文件 | 预估工作量 |
|---|---|---|---|
| 1 | 新增 `CommandExecutor.js`（从 agent-worker 提取） | `src/services/CommandExecutor.js` | 小 |
| 2 | 新增 `ProgressValidator.js` | `src/services/ProgressValidator.js` | 小 |
| 3 | 新增 `DriveOrchestrator.js`（核心模块） | `src/services/DriveOrchestrator.js` | 大 |
| 4 | Todo 表新增 `last_driven_at` 字段 + migration | `src/models/Todo.js` | 小 |
| 5 | server.js 注册 DriveOrchestrator 定时器 | `src/server.js` | 小 |
| 6 | drive 路由增强（bash 执行 + progress 验证） | `src/routes/todos.js` | 中 |
| 7 | agent-worker 重构（复用 CommandExecutor） | `agent-worker.js` | 中 |
| 8 | 测试 | `tests/` | 中 |
| 9 | 文档更新 | `README.md` | 小 |

---

## 十、测试计划

| 测试项 | 验证内容 |
|---|---|
| CommandExecutor.extractBashBlocks | 正确提取 ```bash / ```shell / ```sh 代码块 |
| CommandExecutor.executeCommands | 正常执行、超时处理、失败捕获 |
| ProgressValidator.snapshot | 快照包含 progress/step/blockers |
| ProgressValidator.compare | 有变化返回 changed=true，无变化返回 false |
| DriveOrchestrator.shouldDrive | cooldown 检查、状态过滤、并发保护 |
| DriveOrchestrator.driveTask | 完整执行流程：drive→execute→validate |
| DriveOrchestrator.driveTask 重试 | 无变化时自动重试，耗尽后标记 stalled |
| DriveOrchestrator.tick | 多 agent 扫描、并发限制、stalled 检测 |
| drive 路由增强 | 手动 drive 包含命令执行 + progress 验证 |
| agent-worker 重构 | 复用 CommandExecutor 行为一致 |

---

## 十一、迁移与兼容性

### 迁移

- `last_driven_at` 字段 nullable，向后兼容
- CommandExecutor 是新增模块，不影响现有接口
- agent-worker 重构是内部重构，对外接口不变

### 兼容性

- agent-worker 仍然可以正常运行（作为加速器）
- DriveOrchestrator 是新增的 server 内置执行引擎
- 两者通过 `last_driven_at` cooldown 互斥，不会冲突
- 手动 drive 优先级最高，不受任何限制
